import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Client } from 'pg';

const s3 = new S3Client({});
const bedrock = new BedrockRuntimeClient({ region: process.env.REGION });
const secrets = new SecretsManagerClient({ region: process.env.REGION });

export const handler = async (event: any) => {
    // Get file from S3
    const bucket = event.Records[0].s3.bucket.name;
    const key = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, ' '));
    console.log(`Processing file: ${key} from bucket: ${bucket}`);

    let dbClient;
    try {
        // 2. get config from Secrets Manager
        const secretResponse = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN }));
        const dbConfig = JSON.parse(secretResponse.SecretString!);
        dbClient = new Client({
            host: dbConfig.host,
            port: dbConfig.port,
            user: dbConfig.username,
            password: dbConfig.password,
            database: dbConfig.dbname,
            ssl: { rejectUnauthorized: false } // RDS need SSL
        });
        await dbClient.connect();

        // 3. read file text from S3
        const s3Response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const fullText = await s3Response.Body?.transformToString()!;
        if (!fullText) throw new Error("File trống rỗng!");
        // 4. Chunking 
        const chunkingData = new RecursiveCharacterTextSplitter({
            chunkSize: 800,   // take  2-3 paragraph
            chunkOverlap: 100, // Get more to keep story
        });
        const chunks = await chunkingData.splitText(fullText);
        console.log(`📦 Đã chia thành ${chunks.length} chunks`);
        // 5. Loop chunk to get Vector and Insert
        for (const chunk of chunks) {
            // call Bedrock Titan v2
            const bedrockRes = await bedrock.send(new InvokeModelCommand({
                modelId: "cohere.embed-multilingual-v3",
                contentType: "application/json",
                accept: "application/json",
                body: JSON.stringify({
                    texts: [chunk],
                    input_type: "search_document", // for Ingestion
                    truncate: "NONE"
                })
            }));

            const resBody = JSON.parse(new TextDecoder().decode(bedrockRes.body));
            const embedding = resBody.embeddings[0];

            // Save RDS pgvector
            // Note: embedding in SQL must format'[0.1, 0.2, ...]'
            const vectorString = `[${embedding.join(',')}]`;

            await dbClient.query(
                'INSERT INTO doc_vectors (content, embedding, metadata) VALUES ($1, $2, $3)',
                [chunk, vectorString, JSON.stringify({ source: key, timestamp: new Date().toISOString(), model: "cohere-multilingual-v3" })]
            );
        }
        console.log("Ingestion successful!");
        return { status: "success" };

    } catch (error) {
        console.error("❌ Lỗi:", error);
        throw error;
    } finally {
        if (dbClient) await dbClient.end();
    }
}