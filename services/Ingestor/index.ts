import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { HNSWLib } from "@langchain/community/vectorstores/hnswlib";
import * as fs from "fs";
import * as path from "path";
import { Embeddings } from "@langchain/core/embeddings";

const s3 = new S3Client({});
const TMP_DIR = "/tmp/iot_index";
const bedrockRuntime = new BedrockRuntimeClient({ region: process.env.REGION || "ap-southeast-1" });

class CohereEmbeddingsV3 extends Embeddings {
    constructor() {
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

        // const body = JSON.parse(Buffer.from(response.body).toString());
        // return body.embeddings;
        const responseStr = Buffer.from(response.body).toString('utf-8');
        let body;
        try {
            body = JSON.parse(responseStr);
        } catch (e) {
            console.error("❌ Failed to parse response as JSON:", responseStr.substring(0, 500));
            throw new Error("Invalid JSON response from Bedrock");
        }

        if (!body.embeddings || !Array.isArray(body.embeddings)) {
            console.error("❌ Unexpected response from Cohere:", JSON.stringify(body, null, 2));
            throw new Error(`Invalid response from Cohere Embed: missing 'embeddings' field. Got: ${Object.keys(body)}`);
        }

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

        // const body = JSON.parse(Buffer.from(response.body).toString());
        // return body.embeddings[0];
        const responseStr = Buffer.from(response.body).toString('utf-8');
        let body;
        try {
            body = JSON.parse(responseStr);
        } catch (e) {
            console.error("❌ Failed to parse response:", responseStr.substring(0, 300));
            throw new Error("Invalid JSON response from Bedrock");
        }

        if (!body.embeddings || !Array.isArray(body.embeddings) || body.embeddings.length === 0) {
            console.error("❌ Unexpected embedQuery response:", JSON.stringify(body, null, 2));
            throw new Error("No embeddings returned from Cohere");
        }

        return body.embeddings[0];
    }
}

export const handler = async (event: any) => {
    if (!event.Records && !event.bucket) {
        console.warn("Invalid Trigger: Lambda was called without S3 Records or bucket param.");
        return { statusCode: 400, body: "Missing S3 event data" };
    }
    try {
        // Get file from S3
        const bucket = event.Records[0].s3.bucket.name;
        const key = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, ' '));
        console.log(`Processing file: ${key} from bucket: ${bucket}`);

        // 3. read file text from S3
        const s3Response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const fullText = await s3Response.Body?.transformToString()!;
        if (!fullText) throw new Error("File trống rỗng!");
        // 4. Chunking 
        const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 200, chunkOverlap: 50 });
        const docs = await splitter.createDocuments([fullText]);

        const embeddings = new CohereEmbeddingsV3();

        const vectorStore = await HNSWLib.fromDocuments(docs, embeddings);
        if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);
        await vectorStore.save(TMP_DIR);

        const indexFiles = ["args.json", "docstore.json", "hnswlib.index"];
        for (const fileName of indexFiles) {
            await s3.send(new PutObjectCommand({
                Bucket: bucket,
                Key: `indices/iot_index/${fileName}`,
                Body: fs.readFileSync(path.join(TMP_DIR, fileName))
            }))
        }
        console.log(`Ingested ${docs.length} chunks from ${key}`);
        return { status: "success", count: docs.length };

    } catch (error) {
        console.error("Lỗi:", error);
        throw error;
    }
}