#!/usr/bin/env node

const { createApp } = require('../dist');

createApp().catch((error) => {
  console.error('项目创建失败:', error.message);
  process.exit(1);
});
