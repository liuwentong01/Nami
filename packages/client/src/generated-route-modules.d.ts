declare module '@nami/generated-route-modules' {
  export interface GeneratedRouteDefinition {
    path: string;
    component: string;
    exact?: boolean;
  }

  export const generatedComponentLoaders: Record<
    string,
    () => Promise<{ default: React.ComponentType<unknown> }>
  >;

  export const generatedRouteDefinitions: GeneratedRouteDefinition[];
}
