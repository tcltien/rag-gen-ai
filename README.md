🤖 Real-time IoT AI Assistant (RAG Architecture)

A cloud-native AI operational assistant designed to manage and monitor IoT systems by combining static technical knowledge (PDFs) with dynamic, real-time sensor data (Kafka).

🌟 Key Features
Hybrid RAG Logic: Seamlessly integrates high-fidelity technical manuals with live telemetry data for contextual reasoning.

Cost-Aware Design: Engineered to run within the AWS Free Tier, utilizing a serverless architecture to achieve $0 infrastructure costs.

Event-Driven Architecture: Leverages Kafka for high-throughput sensor data ingestion and real-time AI updates.

🏗️ Architecture & Tech Stack
The system is built with a focus on decoupling and scalability using a "Cloud-first" approach:

Infrastructure as Code: AWS CDK (TypeScript).

Orchestration: AWS Lambda & LangChain (Node.js).

Generative AI Models: Amazon Bedrock (Claude 3 Haiku for reasoning, Titan v2 for Embeddings).

Vector Storage: RDS PostgreSQL with the pgvector extension (using HNSW indexing).

Hot Storage: DynamoDB for tracking the latest "Digital Twin" state of IoT sensors.

Real-time Ingestion: Kafka Event Source Mapping directly to Lambda.

🔄 Data Flow
Knowledge Ingestion:

Technical Csv uploaded to S3 trigger a Lambda function.

Documents are chunked using LangChain and converted to vectors via Titan v2.

Vectors and metadata are stored in RDS pgvector.

Telemetry Ingestion:

Live sensor events from schedule jobs are consumed and updated in DynamoDB.

Inference (RAG Pipeline):

User queries are vectorized and compared against the Knowledge Base in RDS.

The system fetches the current sensor state from DynamoDB.

Claude 3 Haiku synthesizes a final response using both "Theoretical Manuals" and "Real-time Status".

## Useful commands

- `npm run build` compile typescript to js
- `npm run watch` watch for changes and compile
- `npm run test` perform the jest unit tests
- `npx cdk deploy` deploy this stack to your default AWS account/region
- `npx cdk diff` compare deployed stack with current state
- `npx cdk synth` emits the synthesized CloudFormation template
