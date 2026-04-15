import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { Handler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { Client } from 'pg';

const bedrockClient = new BedrockRuntimeClient({ region: process.env.REGION });
const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secrets = new SecretsManagerClient({ region: process.env.REGION });

export const handler: Handler = async (event: any) => {
  console.log("Event received:", JSON.stringify(event));
  const userQuestion = event.question || "Check status device HVAC_01";
  try {
    // Get Vector for question (Use Bedrock - Cohere v3)
    console.time("Get_Embedded");
    const questionVector = await getEmbedding(userQuestion);
    console.timeEnd("Get_Embedded");
    // Hybrid Retrieval
    // Find the device is match in the question
    console.time("Detect_Device");
    const deviceId = detectDeviceId(userQuestion);
    console.timeEnd("Detect_Device");
    console.log(`Device id ${deviceId}`);

    console.time("Search_Vector");
    const staticContext = await searchVectorDB(questionVector);
    console.timeEnd("Search_Vector");

    console.log(`static context ${staticContext}`);
    console.time("Get_live_Data");
    const liveState = await getLiveToData(deviceId);
    console.timeEnd("Get_live_Data");
    console.log(`LiveState ${liveState}`)
    // Build a Prompt và call Claude 3 Haiku
    console.time("invoke_Claude");
    const finalAnswer = await invokeClaude(userQuestion, staticContext, liveState);
    console.timeEnd("invoke_Claude");
    console.log(`final answer ${finalAnswer} `)
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: {
        answer: finalAnswer,
        meta: {
          device: deviceId,
          has_live_data: !!liveState
        }
      }
    };
  } catch (error: any) {
    console.error("DEBUG_BEDROCK_ERROR:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

/**
 * Call claude 3 haiku on bedrock

 * @returns 
 */
async function invokeClaude(question: string, context: string, liveData: any) {
  const liveDataStr = liveData
    ? `Value: ${liveData.value}${liveData.unit}, Status: ${liveData.status} `
    : "No live data in this time";
  const prompt = `Hệ thống có các thông tin sau:
  1.Tài liệu kỹ thuật:
    ${context}
  2. Dữ liệu sensor thực tế(real - time)
    ${liveDataStr}
    Câu hỏi người dùng: ${question}
    Hãy đóng vai một kỹ sư vận hành.So sánh dữ liệu thực tế với ngưỡng an toàn trong tài liệu. 
    Nếu có bất thường, hãy đưa ra cảnh báo và hướng xử lý dựa trên tài liệu. 
    Nếu không có bất thường, hãy báo cáo hệ thống ổn định. Và dịch sáng tiếng anh`;
  const input = {
    modelId: "anthropic.claude-3-haiku-20240307-v1:0",
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }]
    }),
  };
  const command = new InvokeModelCommand(input);
  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  return responseBody.content[0].text;
}

// Call bedrock cohere take embededing
async function getEmbedding(text: string): Promise<number[]> {
  const input = {
    modelId: "cohere.embed-multilingual-v3",
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      texts: [text],
      input_type: "search_query"
    }),
  };

  const command = new InvokeModelCommand(input);
  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  return responseBody.embeddings[0];
}

/**
 * Get new data from dynamoDB
 */
async function getLiveToData(deviceId: string) {
  const command = new QueryCommand({
    TableName: process.env.TABLE_NAME,
    KeyConditionExpression: 'device_id = :id',
    ExpressionAttributeValues: { ":id": deviceId },
    ScanIndexForward: false,
    Limit: 1
  });

  const res = await ddbDocClient.send(command);
  return res.Items?.[0] || null;
}

/**
 * Simple Logic to detect Device Id from the question
 */
function detectDeviceId(text: string): string {
  if (text.includes("HVAC")) return "HVAC_01";
  if (text.includes("POWER") || text.includes("điện")) return "POWER_METER_01";
  if (text.includes("HUMID") || text.includes("ẩm")) return "HUMID_01";
  return "HVAC_01"; // Default demo
}


async function searchVectorDB(vector: number[]): Promise<string> {
  const secretResponse = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN }));
  const dbConfig = JSON.parse(secretResponse.SecretString!);
  const dbClient = new Client({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.username,
    password: dbConfig.password,
    database: dbConfig.dbname,
    ssl: { rejectUnauthorized: false } // RDS need SSL
  });
  console.log("Attempting to connect to DB...");
  await dbClient.connect();
  console.log("Connected successfully!");
  try {
    // SQL: Get content On Cosine Distance (<=>)
    const res = await dbClient.query(
      `SELECT content FROM doc_vectors 
             ORDER BY embedding <=> $1 
             LIMIT 2`,
      [JSON.stringify(vector)]
    );
    return res.rows.map(r => r.content).join("\n---\n");
  } finally {
    await dbClient.end();
  }
}

