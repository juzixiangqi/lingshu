/**
 * Vitest 全局 setup：必须在任何业务模块被导入之前设置环境变量。
 * 测试库与开发库隔离（lingshu_test / Redis db 9）。
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://lingshu:lingshu@localhost:5432/lingshu_test';
process.env.REDIS_URL = 'redis://localhost:6379/9';
process.env.JWT_SECRET = 'lingshu-test-secret';
process.env.DEV_LOGIN_ENABLED = 'true';
process.env.LINGXI_WEBHOOK_URL = '';
process.env.WEB_BASE_URL = 'http://localhost:5173';
process.env.COLLAB_SHARDS = 'ws://localhost:1234|ws://localhost:1235';
