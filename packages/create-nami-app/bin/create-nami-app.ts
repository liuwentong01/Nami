#!/usr/bin/env node

/**
 * create-nami-app - 脚手架入口
 *
 * 使用方式：
 * npx create-nami-app my-app
 * npx create-nami-app my-app --template ssr
 */

import { createApp } from '../src/index';

createApp().catch((error) => {
  console.error('项目创建失败:', error.message);
  process.exit(1);
});
