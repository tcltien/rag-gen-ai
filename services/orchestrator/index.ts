import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { Embeddings } from "@langchain/core/embeddings";
import * as fs from "fs/promises";
import * as path from "path";
import { HNSWLib } from "@langchain/community/vectorstores/hnswlib";
import { Handler } from "aws-lambda";

const s3 = new S3Client({});
const bedrockClient = new BedrockRuntimeClient({ region: process.env.REGION || "ap-southeast-1" });

const TMP_DIR = "/tmp/iot_index";
const INDEX_S3_PREFIX = "indices/iot_index";
const BUCKET_NAME = process.env.BUCKET_NAME;

// ====================== CUSTOM EMBEDDINGS ======================
class QueryEmbeddings extends Embeddings {
  constructor() {
    super({});
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    throw new Error("embedDocuments should not be called in retrieval phase");
  }

  async embedQuery(text: string): Promise<number[]> {
    const response = await bedrockClient.send(
      new InvokeModelCommand({
        modelId: "cohere.embed-multilingual-v3",
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          texts: [text],
          input_type: "search_query",
          truncate: "NONE"
        })
      })
    );

    const body = JSON.parse(new TextDecoder().decode(response.body));
    return body.embeddings[0];
  }
}
// ====================== GỌI CLAUDE 3 HAIKU ======================
async function callClaudeHaiku(prompt: string, maxTokens = 700): Promise<string> {
  const command = new InvokeModelCommand({
    modelId: "anthropic.claude-3-haiku-20240307-v1:0",
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: maxTokens,
      temperature: 0.6,
      top_p: 0.9,
      messages: [{ role: "user", content: prompt }]
    })
  });

  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));

  return responseBody.content[0].text.trim();
}

function createPrompt(question: string, context: string): string {
  return `Bạn là chuyên gia tư vấn về IoT, trả lời rõ ràng, chính xác và dễ hiểu bằng tiếng Việt.

  Thông tin tham khảo:
  ${context || "Không tìm thấy thông tin liên quan."}

  Câu hỏi: ${question}

  Hướng dẫn:
  - Dựa chắc chắn vào thông tin được cung cấp.
  - Nếu không có thông tin, hãy trả lời trung thực là "Tôi chưa có thông tin về vấn đề này."
  - Trả lời ngắn gọn, logic, có thể dùng danh sách nếu cần.
  - Không bịa thông tin.`;
}

async function cleanupTmpDir() {
  try {
    await fs.rm(TMP_DIR, { recursive: true, force: true });
    console.log("🧹 Cleaned up temporary directory");
  } catch (err) {
    console.warn("Warning: Cleanup failed", err);
  }
}

function createResponse(statusCode: number, body: any) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"   // Nếu dùng API Gateway
    },
    body: JSON.stringify(body)
  };
}

async function downloadIndexFromS3(): Promise<void> {
  const indexFiles = ["args.json", "docstore.json", "hnswlib.index"];
  await fs.mkdir(TMP_DIR, { recursive: true });
  for (const fileName of indexFiles) {
    const response = await s3.send(new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: `${INDEX_S3_PREFIX}/${fileName}`
    }));

    const buffer = await response.Body?.transformToByteArray();
    if (buffer) {
      await fs.writeFile(path.join(TMP_DIR, fileName), buffer);
    }
  }
}

export const handler: Handler = async (event: any) => {
  const question = typeof event.body === 'string'
    ? JSON.parse(event.body).question
    : event.question;

  if (!question || typeof question !== 'string') {
    return createResponse(400, { error: "Missing 'question' field" });
  }
  console.log(`Question: ${question}`);

  let vectorStore: HNSWLib | null = null;
  try {
    // 1. Tải index từ S3
    await downloadIndexFromS3();
    // 2. Load Vector Store
    vectorStore = await HNSWLib.load(TMP_DIR, new QueryEmbeddings());
    console.log("Vector store loaded successfully");

    // 3. Retrieval
    const relevantDocs = await vectorStore.similaritySearch(question, 5); // Lấy tối đa 5 chunks
    const contextText = relevantDocs.map(d => d.pageContent).join("\n\n");

    console.log(` Retrieved ${relevantDocs.length} relevant documents`);
    // 4. Tạo Prompt tối ưu
    const prompt = createPrompt(question, contextText);

    // 5. Gọi LLM
    const answer = await callClaudeHaiku(prompt);

    // 6. response
    return createResponse(200, {
      question,
      answer,
      sourcesCount: relevantDocs.length,
      // metadata: relevantDocs.map(d => d.metadata)
    });

  } catch (error: any) {
    console.error("DEBUG_BEDROCK_ERROR:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  } finally {
    // Cleanup để tránh đầy /tmp
    await cleanupTmpDir();
  }
};