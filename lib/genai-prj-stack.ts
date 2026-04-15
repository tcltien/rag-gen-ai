import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3"; // Import module S3
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs"; // <--- Chỉ lấy hàm khởi tạo từ đây
import * as path from "path";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { Duration } from 'aws-cdk-lib';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class GenaiPrjStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // BƯỚC A: TẠO S3 BUCKET (Nơi chứa PDF tài liệu kỹ thuật)
    const documentBucket = new s3.Bucket(this, "TechnicalDocsBucket", {
      versioned: true, // Lưu lại các phiên bản cũ của file (an toàn dữ liệu)
      encryption: s3.BucketEncryption.S3_MANAGED, // Mã hóa dữ liệu tự động
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Khi xóa Stack thì xóa luôn Bucket (chỉ dùng cho Dev)
      autoDeleteObjects: true, // Tự xóa file trong bucket khi xóa Stack
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, // Chặn hoàn toàn truy cập từ Internet
    });

    // In ra tên Bucket sau khi tạo xong để mình biết mà dùng
    new cdk.CfnOutput(this, "BucketName", { value: documentBucket.bucketName });

    // config vpc only using public subnet NAT gateway = 0
    const vpc = new ec2.Vpc(this, "IotAiVpc", {
      maxAzs: 2,
      natGateways: 0, // Tiết kiệm chi phí
      subnetConfiguration: [
        {
          name: "PublicSubnet",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // 2. Security Group cho RDS
    const dbSg = new ec2.SecurityGroup(this, "RdsSecurityGroup", {
      vpc,
      description: "Allow inbound traffic to RDS",
      allowAllOutbound: true,
    });

    dbSg.addIngressRule(
      ec2.Peer.ipv4("183.81.49.12/32"), // Khuyến nghị: Thay bằng ec2.Peer.ipv4('YOUR_IP/32')
      ec2.Port.tcp(5432),
      "Allow DBeaver access",
    );

    const dbInstance = new rds.DatabaseInstance(this, "IotAiDB", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE3,
        ec2.InstanceSize.MICRO,
      ),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [dbSg],
      databaseName: "iot_ai_db", // Khớp với Master Recap
      publiclyAccessible: true, // Cần thiết để kết nối từ local không qua VPN/Bastion
      allocatedStorage: 20,
      backupRetention: cdk.Duration.days(0), // Demo mode, tắt backup để tiết kiệm
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Xóa sạch khi destroy stack
    });

    const iotTable = new dynamodb.Table(this, "IoTDeviceStatus", {
      tableName: 'IoTDeviceStatus',
      partitionKey: { name: 'device_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    //add Index focast warning sensor
    iotTable.addGlobalSecondaryIndex({
      indexName: 'StatusIndex',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // Output Endpoint để copy vào DBeaver
    new cdk.CfnOutput(this, "RdsEndpoint", {
      value: dbInstance.dbInstanceEndpointAddress,
    });

    // create a lambda function
    const orchestratorLambda = new NodejsFunction(this, "RAGOrchestrator", {
      entry: path.join(__dirname, "../services/orchestrator/index.ts"), // Trỏ thẳng vào file TS
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      allowPublicSubnet: true,
      environment: {
        DATA_BUCKET: documentBucket.bucketName, // Truyền tên Bucket vào Lambda
        DB_SECRET_ARN: dbInstance.secret?.secretArn || "",
        REGION: this.region,
        TABLE_NAME: iotTable.tableName,
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });
    // Grant permission for simulator lambda
    iotTable.grantReadData(orchestratorLambda);
    documentBucket.grantRead(orchestratorLambda);
    dbInstance.secret?.grantRead(orchestratorLambda);
    dbInstance.connections.allowDefaultPortFrom(orchestratorLambda); // allow lambda conenct
    orchestratorLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`,
          `arn:aws:bedrock:${this.region}::foundation-model/cohere.embed-multilingual-v3`,
        ],
      }),
    );

    //create a lambda ingestor
    const ingestorLambda = new NodejsFunction(this, "IngestorLambda", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, "../services/ingestor/index.ts"),
      handler: "handler",
      timeout: cdk.Duration.minutes(5),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      allowPublicSubnet: true,
      environment: {
        DB_SECRET_ARN: dbInstance.secret?.secretArn || "",
        DATA_BUCKET: documentBucket.bucketName,
        REGION: this.region,
      },
      bundling: {
        externalModules: ["aws-sdk"], // Giảm dung lượng bundle
      },
    });

    // Create Lambda Simulator
    const simulatorLambda = new NodejsFunction(this, 'IoTSimulator', {
      entry: path.join(__dirname, "../services/simulator/index.ts"),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      environment: {
        TABLE_NAME: iotTable.tableName,
        DB_SECRET_ARN: dbInstance.secret?.secretArn || "",
        DATA_BUCKET: documentBucket.bucketName,
        REGION: this.region,
      },
    });

    // Grant permission for simulator lambda
    iotTable.grantWriteData(simulatorLambda);
    // create Schedule Rule (run each 2 min)
    const rule = new Rule(this, 'SimulatorRule', {
      schedule: Schedule.rate(Duration.minutes(5)),
    });
    rule.addTarget(new LambdaFunction(simulatorLambda));

    //Permission for ingestor lambda
    documentBucket.grantRead(ingestorLambda);
    dbInstance.secret?.grantRead(ingestorLambda);
    dbInstance.connections.allowDefaultPortFrom(ingestorLambda); // allow lambda conenct
    ingestorLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/cohere.embed-multilingual-v3`,
        ],
      }),
    );
    // 1. Endpoint cho Secrets Manager (Để lấy Pass DB)
    vpc.addInterfaceEndpoint("SecretsManagerEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
    });

    // 2. Endpoint cho Bedrock (Để lấy Vector)
    vpc.addInterfaceEndpoint("BedrockEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
    });

    // 3. Endpoint cho S3 (Để đọc file .txt) - Gateway Endpoint thường FREE
    vpc.addGatewayEndpoint("S3Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
    // endpoint cho dynamoDB
    vpc.addGatewayEndpoint("DynamoDbEndpoint", {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });
  }
}
