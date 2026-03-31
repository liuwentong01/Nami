/**
 * create-nami-app - 交互式问答
 *
 * 收集用户创建项目的偏好信息。
 */

import inquirer from 'inquirer';
import validatePackageName from 'validate-npm-package-name';

/**
 * 项目配置选项
 */
export interface ProjectOptions {
  /** 项目名称 */
  projectName: string;
  /** 项目描述 */
  description: string;
  /** 项目模板类型 */
  template: 'csr' | 'ssr' | 'ssg' | 'full';
  /** 是否使用官方插件 */
  plugins: string[];
  /** 作者名称 */
  author: string;
}

/**
 * 模板描述
 */
const TEMPLATE_CHOICES = [
  { name: 'CSR  - 客户端渲染（适合后台管理、SPA 应用）', value: 'csr' },
  { name: 'SSR  - 服务端渲染（适合 SEO 要求高的页面）', value: 'ssr' },
  { name: 'SSG  - 静态站点生成（适合文档、博客等内容型站点）', value: 'ssg' },
  { name: 'Full - 完整模板（包含所有渲染模式示例）', value: 'full' },
];

/**
 * 可选官方插件
 */
const PLUGIN_CHOICES = [
  { name: '@nami/plugin-cache     缓存策略', value: '@nami/plugin-cache' },
  { name: '@nami/plugin-monitor   监控埋点', value: '@nami/plugin-monitor' },
  { name: '@nami/plugin-skeleton  骨架屏', value: '@nami/plugin-skeleton' },
  { name: '@nami/plugin-request   统一请求层', value: '@nami/plugin-request' },
  { name: '@nami/plugin-error-boundary  错误边界', value: '@nami/plugin-error-boundary' },
];

/**
 * 执行交互式问答
 *
 * @param projectName - 命令行传入的项目名称（可选）
 * @param template - 命令行传入的模板类型（可选）
 * @returns 用户选择的项目配置
 */
export async function promptUserOptions(
  projectName?: string,
  template?: string,
): Promise<ProjectOptions> {
  const questions: inquirer.QuestionCollection = [];

  // 项目名称
  if (!projectName) {
    questions.push({
      type: 'input',
      name: 'projectName',
      message: '项目名称:',
      default: 'my-nami-app',
      validate: (input: string) => {
        const result = validatePackageName(input);
        if (result.validForNewPackages) return true;
        return `无效的项目名称: ${(result.errors || result.warnings || []).join(', ')}`;
      },
    });
  }

  // 项目描述
  questions.push({
    type: 'input',
    name: 'description',
    message: '项目描述:',
    default: 'A Nami framework application',
  });

  // 模板选择
  if (!template) {
    questions.push({
      type: 'list',
      name: 'template',
      message: '选择项目模板:',
      choices: TEMPLATE_CHOICES,
      default: 'ssr',
    });
  }

  // 插件选择
  questions.push({
    type: 'checkbox',
    name: 'plugins',
    message: '选择需要的官方插件:',
    choices: PLUGIN_CHOICES,
    default: ['@nami/plugin-request', '@nami/plugin-error-boundary'],
  });

  // 作者
  questions.push({
    type: 'input',
    name: 'author',
    message: '作者:',
    default: '',
  });

  const answers = await inquirer.prompt(questions);

  return {
    projectName: projectName || answers.projectName,
    description: answers.description,
    template: (template as ProjectOptions['template']) || answers.template,
    plugins: answers.plugins,
    author: answers.author,
  };
}
