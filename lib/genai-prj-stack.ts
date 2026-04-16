import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as path from "path";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { Duration, Size } from "aws-cdk-lib";

export class GenaiPrjStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ==================== S3 BUCKET ====================
    const documentBucket = new s3.Bucket(this, "TechnicalDocsBucket", {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    new cdk.CfnOutput(this, "BucketName", {
      value: documentBucket.bucketName,
      description: "Bucket chứa tài liệu IoT"
    });

    // ==================== DYNAMODB TABLE ====================
    const iotTable = new dynamodb.Table(this, "IoTDeviceStatus", {
      tableName: "IoTDeviceStatus",
      partitionKey: { name: "device_id", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: "ttl",
    });

    iotTable.addGlobalSecondaryIndex({
      indexName: "StatusIndex",
      partitionKey: { name: "status", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ==================== RAG ORCHESTRATOR LAMBDA ====================
    const orchestratorLambda = new NodejsFunction(this, "RAGOrchestrator", {
      entry: path.join(__dirname, "../services/orchestrator/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      // architecture: lambda.Architecture.X86_64,      
      memorySize: 1024,
      timeout: Duration.seconds(45),
      ephemeralStorageSize: Size.mebibytes(2048),

      environment: {
        BUCKET_NAME: documentBucket.bucketName,
        REGION: this.region,
        TABLE_NAME: iotTable.tableName,
      },

      bundling: {
        forceDockerBundling: true,
        minify: true,
        sourceMap: false,
        target: "node20",

        externalModules: [
          "hnswlib-node",
          "@aws-sdk/*",
          "@smithy/*",
        ],
        nodeModules: ["hnswlib-node"],
      },
    });

    // ==================== INGESTOR LAMBDA ====================
    const ingestorLambda = new NodejsFunction(this, "IngestorLambda", {
      entry: path.join(__dirname, "../services/ingestor/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      // architecture: lambda.Architecture.X86_64,
      memorySize: 1024,
      timeout: Duration.minutes(5),
      ephemeralStorageSize: Size.mebibytes(2048),

      environment: {
        BUCKET_NAME: documentBucket.bucketName,
        REGION: this.region,
      },

      bundling: {
        forceDockerBundling: true,
        minify: true,
        sourceMap: false,
        target: "node20",

        externalModules: [
          "hnswlib-node",
          "@aws-sdk/*",
          "@smithy/*",
        ],
        nodeModules: ["hnswlib-node"],
      },
    });

    // ==================== SIMULATOR LAMBDA ====================
    const simulatorLambda = new NodejsFunction(this, "IoTSimulator", {
      entry: path.join(__dirname, "../services/simulator/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 512,
      timeout: Duration.seconds(30),
      environment: {
        TABLE_NAME: iotTable.tableName,
        BUCKET_NAME: documentBucket.bucketName,
        REGION: this.region,
      },
    });

    // ==================== PERMISSIONS ====================
    documentBucket.grantReadWrite(orchestratorLambda);
    documentBucket.grantReadWrite(ingestorLambda);
    iotTable.grantReadData(orchestratorLambda);
    iotTable.grantWriteData(simulatorLambda);

    // Bedrock permissions
    const bedrockPolicy = new iam.PolicyStatement({
      actions: ["bedrock:InvokeModel"],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`,
        `arn:aws:bedrock:${this.region}::foundation-model/cohere.embed-multilingual-v3`,
      ],
    });

    orchestratorLambda.addToRolePolicy(bedrockPolicy);
    ingestorLambda.addToRolePolicy(bedrockPolicy);

    // ==================== SCHEDULE ====================
    const rule = new Rule(this, "SimulatorRule", {
      schedule: Schedule.rate(Duration.minutes(5)),
    });
    rule.addTarget(new LambdaFunction(simulatorLambda));

    // Output
    new cdk.CfnOutput(this, "OrchestratorFunctionName", { value: orchestratorLambda.functionName });
    new cdk.CfnOutput(this, "IngestorFunctionName", { value: ingestorLambda.functionName });
  }
}