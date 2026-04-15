import { DynamoDB } from 'aws-sdk';
const db = new DynamoDB.DocumentClient();

export const handler = async () => {
    const devices = [
        { id: 'HVAC_01', name: 'Hệ thống điều hòa', range: [18, 28], unit: '°C' },
        { id: 'POWER_METER_01', name: 'Công tơ điện', range: [100, 500], unit: 'W' },
        { id: 'HUMID_01', name: 'Cảm biến độ ẩm', range: [40, 70], unit: '%' }
    ];

    const timestamp = Date.now();
    const ttl = Math.floor(timestamp / 1000) + (24 * 3600); // 1 ngày sau xóa

    for (const dev of devices) {
        const value = Math.floor(Math.random() * (dev.range[1] - dev.range[0] + 1) + dev.range[0]);

        await db.put({
            TableName: process.env.TABLE_NAME!,
            Item: {
                device_id: dev.id,
                device_name: dev.name,
                timestamp,
                value,
                unit: dev.unit,
                status: value > dev.range[1] * 0.9 ? 'WARNING' : 'OPERATING',
                ttl
            }
        }).promise();
    }

    return { statusCode: 200, body: 'Data simulated!' };
};