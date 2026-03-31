/**
 * @nami/webpack - TypeScript 编译规则
 *
 * 配置 Webpack 处理 .ts/.tsx 文件的规则。
 * 使用 ts-loader 进行 TypeScript 编译，支持：
 * - TSX/JSX 语法
 * - 项目引用（Project References）
 * - 增量编译
 */

import type { RuleSetRule } from 'webpack';

/**
 * TypeScript 规则配置选项
 */
export interface TypeScriptRuleOptions {
  /** 是否启用转译模式（跳过类型检查，加速编译） */
  transpileOnly?: boolean;
  /** 自定义 tsconfig 路径 */
  configFile?: string;
  /** 是否为服务端构建 */
  isServer?: boolean;
}

/**
 * 创建 TypeScript 编译规则
 *
 * @param options - 规则配置选项
 * @returns Webpack RuleSetRule
 */
export function createTypeScriptRule(options: TypeScriptRuleOptions = {}): RuleSetRule {
  const { transpileOnly = true, configFile, isServer = false } = options;

  return {
    test: /\.(ts|tsx)$/,
    exclude: /node_modules/,
    use: [
      {
        loader: 'ts-loader',
        options: {
          // 默认启用转译模式以加速构建
          // 类型检查由单独的 fork-ts-checker-webpack-plugin 或 tsc --noEmit 完成
          transpileOnly,
          // 指定 tsconfig 文件路径
          ...(configFile ? { configFile } : {}),
          compilerOptions: {
            // 服务端构建使用 CommonJS，客户端使用 ESM 以支持 Tree Shaking
            module: isServer ? 'commonjs' : 'esnext',
            // 服务端不需要 JSX 运行时的自动导入
            ...(isServer ? {} : { jsx: 'react-jsx' }),
          },
        },
      },
    ],
  };
}
