import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { HNSWLib } from "@langchain/community/vectorstores/hnswlib";
import { Embeddings } from "@langchain/core/embeddings";

import * as path from "path";
const bedrockRuntime = new BedrockRuntimeClient({ region: process.env.REGION || "ap-southeast-1" });

class CohereEmbeddingsV3 extends Embeddings {
    constructor() {
        // Truyền params rỗng (hoặc có thể truyền thêm nếu cần)
        super({});
    }

    async embedDocuments(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) return [];

        const response = await bedrockRuntime.send(
            new InvokeModelCommand({
                modelId: "cohere.embed-multilingual-v3",
                contentType: "application/json",
                accept: "application/json",
                body: JSON.stringify({
                    texts: texts,
                    input_type: "search_document",   // ingestion
                    truncate: "NONE"
                })
            })
        );

        const body = JSON.parse(new TextDecoder().decode(response.body));
        return body.embeddings;
    }

    async embedQuery(text: string): Promise<number[]> {
        const response = await bedrockRuntime.send(
            new InvokeModelCommand({
                modelId: "cohere.embed-multilingual-v3",
                contentType: "application/json",
                accept: "application/json",
                body: JSON.stringify({
                    texts: [text],
                    input_type: "search_query",     // query
                    truncate: "NONE"
                })
            })
        );

        const body = JSON.parse(new TextDecoder().decode(response.body));
        return body.embeddings[0];
    }
}


async function testOrchestration() {
    console.log("🔍 Bắt đầu hệ thống Orchestration Local...");
    console.time();
    // 1. Khởi tạo Embeddings - Chú ý input_type là search_query
    const embeddings = new CohereEmbeddingsV3();

    try {
        // 2. Load Index từ folder đã tạo bởi Ingestor
        const directory = path.join(process.cwd(), "local_index");
        console.log(`📂 Đang nạp Index từ: ${directory}`);

        const vectorStore = await HNSWLib.load(directory, embeddings);

        // 3. Giả lập câu hỏi của người dùng
        const query = "hôm nay thế giới có sự kiện gì quan trọng không";
        console.log(`Câu hỏi: "${query}"`);

        // 4. Tìm kiếm các đoạn văn bản liên quan nhất (Similarity Search)
        // k=3 nghĩa là lấy 3 đoạn có nội dung gần nhất
        const results = await vectorStore.similaritySearch(query, 3);
        const contextText = results.map(d => d.pageContent).join("\n\n");

        // 4. CALL CLAUDE BẰNG NATIVE CLIENT
        const prompt = `Bạn là trợ lý kỹ thuật. Dựa vào tài liệu sau: ${contextText} Câu hỏi: ${query}`;
        const input = {
            modelId: "anthropic.claude-3-haiku-20240307-v1:0",
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify({
                anthropic_version: "bedrock-2023-05-31",
                max_tokens: 500,
                messages: [
                    { role: "user", content: [{ type: "text", text: prompt }] }
                ],
                temperature: 0,
            }),
        };

        console.log("📡 Sending request to Bedrock...");
        const command = new InvokeModelCommand(input);
        const response = await bedrockRuntime.send(command);

        // Parse kết quả trả về
        const resBody = JSON.parse(new TextDecoder().decode(response.body));
        console.log("\n✨ Claude trả lời:");
        console.log(resBody.content[0].text);
        console.timeEnd();

    } catch (error) {
        console.error("❌ Lỗi Orchestration:", error);
    }
}

testOrchestration();