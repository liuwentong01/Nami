declare module '@nami/generated-route-modules' {
  export const generatedComponentLoaders: Record<
    string,
    () => Promise<{ default: React.ComponentType<unknown> }>
  >;
}
