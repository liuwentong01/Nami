declare module '*.js?service-worker' {
  const url: string;
  export default url;
}

interface NamiShowcaseEvent {
  name: string;
  at: string;
  detail?: Record<string, unknown>;
}

interface Window {
  __NAMI_DATA__?: Record<string, unknown>;
  __NAMI_SHOWCASE_EVENTS__?: NamiShowcaseEvent[];
}
