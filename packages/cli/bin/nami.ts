#!/usr/bin/env node

/**
 * @nami/cli - 命令行入口
 *
 * Nami 框架的命令行工具，提供以下命令：
 * - nami dev     启动开发服务器
 * - nami build   生产构建
 * - nami start   启动生产服务
 * - nami generate 静态页面生成
 * - nami analyze  Bundle 分析
 * - nami info     环境信息
 */

import { createCLI } from '../src/index';

// 启动 CLI
createCLI().parse(process.argv);
