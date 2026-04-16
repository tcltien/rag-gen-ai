import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { HNSWLib } from "@langchain/community/vectorstores/hnswlib";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Embeddings } from "@langchain/core/embeddings";
import * as fs from "fs";

const bedrockRuntime = new BedrockRuntimeClient({ region: process.env.REGION || "ap-southeast-1" });


// ====================== CUSTOM EMBEDDINGS ======================
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


async function testLocalIngest() {
    console.log("🚀 Bắt đầu test Ingest Local...");

    // 1. Giả lập đọc file thô (Thay vì lấy từ S3)
    const fullText = fs.readFileSync("./test-data.txt", "utf-8");

    // 2. Chunking
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 100, chunkOverlap: 50 });
    const docs = await splitter.createDocuments([fullText]);

    // 3. Khởi tạo Embeddings
    const embeddings = new CohereEmbeddingsV3();

    try {
        // 4. Gọi Bedrock & Tạo Index (Bước này tốn tiền nè, nhưng ít thôi)
        console.log("📡 Đang gửi dữ liệu lên Bedrock để tạo Vector...");
        const vectorStore = await HNSWLib.fromDocuments(docs, embeddings);

        // 5. Lưu xuống folder local thay vì S3 để kiểm tra
        const outputPath = "./local_index";
        await vectorStore.save(outputPath);

        console.log(`✅ Thành công! Index đã được lưu tại: ${outputPath}`);
        console.log("Bạn hãy check trong folder đó xem có file 'hnswlib.index' chưa.");
    } catch (error) {
        console.error("❌ Lỗi rồi:", error);
    }
}

testLocalIngest();