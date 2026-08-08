import { useNamiData } from '@nami/client';

/**
 * 让同一个页面组件同时适配服务端直接传 props 与客户端注水快照。
 *
 * 当前服务端 entry 会把 initialData 作为 props 传给页面；浏览器 Router 则
 * 直接渲染页面组件，因此客户端通过 useNamiData 读取首屏快照。
 */
export function useShowcaseData<T extends Record<string, unknown>>(serverData?: T): T {
  const hydratedData = useNamiData<T>();

  if (typeof window === 'undefined') {
    return serverData ?? ({} as T);
  }

  return hydratedData && Object.keys(hydratedData).length > 0
    ? hydratedData
    : (serverData ?? ({} as T));
}
