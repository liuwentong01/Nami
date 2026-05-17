# Quick Start

This document helps you create your first Nami project and understand the core workflow within 10 minutes. After reading it, you will be able to:

- Create and run a Nami project
- Understand what each field in the configuration file means
- Write pages in the four modes: SSR/SSG/ISR/CSR
- Use data prefetching, route navigation, and Head management

---

## 1. Create a Project

```bash
# Create a project with the scaffold
npx create-nami-app my-app

# Interactive selections:
# - Template type: csr / ssr / ssg / full
# - Official plugins: cache / monitor / skeleton / error-boundary / request
```

The scaffold generates the following structure:

```
my-app/
├── src/
│   ├── pages/
│   │   ├── home.tsx          # Home page component
│   │   └── about.tsx         # About page
│   ├── layouts/
│   │   └── default.tsx       # Default layout
│   ├── entry-client.tsx      # Client entry
│   ├── entry-server.tsx      # Server entry (SSR/SSG modes)
│   └── global.css            # Global styles
├── nami.config.ts            # Framework configuration file
├── tsconfig.json
└── package.json
```

## 2. Core Configuration File

`nami.config.ts` is the configuration center of the whole project. The following explains each configuration item and how to choose values for it:

```typescript
// nami.config.ts
import { defineConfig } from '@nami/core';

export default defineConfig({
  // ===== Basic information =====
  // App name — used for log prefixes and monitoring identifiers; recommended to match the project name (required)
  appName: 'my-app',

  // Default rendering mode — used when a route does not explicitly specify renderMode
  // Most projects choose 'ssr' (balances SEO and data freshness)
  defaultRenderMode: 'ssr',

  // ===== Route configuration =====
  // Each route specifies: URL path → component file → rendering mode → data prefetch function
  routes: [
    {
      path: '/',
      component: './pages/home',       // Relative to srcDir (default 'src')
      renderMode: 'ssr',               // Rendered on the server for every request
      getServerSideProps: 'getServerSideProps', // Exported function name in the corresponding component file
    },
    {
      path: '/about',
      component: './pages/about',
      renderMode: 'ssg',               // Generate static HTML at build time and return it directly at runtime
    },
    {
      path: '/blog/:slug',             // :slug is a dynamic parameter and matches /blog/hello-world
      component: './pages/blog-detail',
      renderMode: 'isr',               // Render and cache on first request; regenerate in the background after expiration
      revalidate: 60,                  // Mark as stale after 60 seconds and trigger background revalidation
      getStaticProps: 'getStaticProps',
      getStaticPaths: 'getStaticPaths', // Declare paths that need to be pre-generated at build time
    },
    {
      path: '/dashboard',
      component: './pages/dashboard',
      renderMode: 'csr',               // Server returns shell HTML; browser renders on the client
    },
  ],

  // ===== Server configuration =====
  server: {
    port: 3000,
    host: '0.0.0.0',              // 0.0.0.0 = listen on all network interfaces (required for Docker / K8s)
    ssrTimeout: 5000,             // SSR rendering timeout in milliseconds; automatically degrades on timeout
    gracefulShutdown: true,       // Enable graceful shutdown (wait for in-flight requests after SIGTERM)
    gracefulShutdownTimeout: 30000, // Upper bound for graceful shutdown; should be < K8s terminationGracePeriodSeconds
  },

  // ===== ISR configuration =====
  isr: {
    enabled: true,
    cacheAdapter: 'memory',       // Use memory for development, filesystem for single-machine multi-process, redis for multi-machine
    defaultRevalidate: 60,        // Default value in seconds when a route does not specify revalidate
  },

  // ===== Degradation configuration =====
  // Fault-tolerance strategy when SSR rendering fails
  fallback: {
    ssrToCSR: true,               // Automatically degrade to CSR when SSR fails (shell HTML + JS)
    maxRetries: 1,                // Retry once after rendering failure (handles transient failures)
    timeout: 5000,                // Timeout for the degradation process
  },

  // ===== Static assets =====
  assets: {
    publicPath: '/',              // CDN prefix, for example 'https://cdn.example.com/'
    hash: true,                   // Enable content hash (for example main.abc123.js) for long-term caching
  },

  // ===== Build and client injection =====
  webpack: {
    client: (config) => config,    // Modify browser-side Webpack configuration
    server: (config) => config,    // Modify Node-side Webpack configuration
  },
  monitor: {
    enabled: false,
    sampleRate: 1,
    webVitals: true,
    renderMetrics: true,
  },
  env: {
    NAMI_PUBLIC_API_BASE: '/api',  // The NAMI_PUBLIC_ prefix is injected into client code
  },
  title: 'My Nami App',            // Default page title
  description: 'Powered by Nami',  // Default page description
  // htmlTemplate: './src/document.html',

  // ===== Plugins =====
  plugins: [
    // Can be plugin instances, such as new NamiCachePlugin({...})
    // Can also be plugin package-name strings, such as '@nami/plugin-monitor'
  ],
});
```

> **Tip**: `defineConfig` provides TypeScript type hints, so you can get autocomplete and type checking for all configuration items in your IDE.

## 3. Write Page Components

### SSR Page (with Data Prefetching)

```typescript
// src/pages/home.tsx
import React from 'react';

interface HomeProps {
  title: string;
  items: Array<{ id: number; name: string }>;
}

export default function Home({ title, items }: HomeProps) {
  return (
    <div>
      <h1>{title}</h1>
      <ul>
        {items.map(item => (
          <li key={item.id}>{item.name}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Server-side data prefetch function
 *
 * - Semantically, it should only run on the server
 * - To ensure the implementation does not enter the client Bundle, integrate data-fetch-loader or equivalent stripping logic into the client build
 * - Called on every request
 * - Returned props are injected into component props
 * - Also serialized into HTML for client Hydration
 */
export async function getServerSideProps(ctx) {
  const { params, query, headers } = ctx;

  const res = await fetch('https://api.example.com/items');
  const items = await res.json();

  return {
    props: {
      title: 'Home',
      items,
    },
  };
}
```

### SSG Page (Generated at Build Time)

```typescript
// src/pages/about.tsx
import React from 'react';

export default function About() {
  return <div><h1>About Us</h1></div>;
}
```

### ISR Page (Incremental Static Regeneration)

```typescript
// src/pages/blog-detail.tsx
import React from 'react';

export default function BlogDetail({ post }) {
  return (
    <article>
      <h1>{post.title}</h1>
      <div dangerouslySetInnerHTML={{ __html: post.content }} />
    </article>
  );
}

/**
 * Build-time data prefetching (ISR also uses this function)
 * Unlike getServerSideProps, the result of this function is cached
 */
export async function getStaticProps(ctx) {
  const { params } = ctx;
  const post = await fetch(`https://api.example.com/posts/${params.slug}`).then(r => r.json());

  return {
    props: { post },
  };
}

/**
 * Declare all paths that need to be generated at build time
 * In ISR mode, paths not listed here are dynamically generated on first request
 */
export async function getStaticPaths() {
  const posts = await fetch('https://api.example.com/posts').then(r => r.json());

  return {
    paths: posts.map(p => ({ params: { slug: p.slug } })),
    fallback: 'blocking', // Synchronously render non-pre-generated paths on first visit
  };
}
```

### CSR Page (Pure Client-Side Rendering)

```typescript
// src/pages/dashboard.tsx
import React, { useState, useEffect } from 'react';

/**
 * CSR pages do not need getServerSideProps or getStaticProps.
 * Data is fetched in the browser via useEffect / useClientFetch.
 *
 * The server only returns shell HTML (<div id="nami-root"></div> + JS),
 * and the browser executes React rendering after downloading JS.
 */
export default function Dashboard() {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    fetch('/api/dashboard/stats')
      .then(res => res.json())
      .then(setStats);
  }, []);

  if (!stats) return <div>Loading...</div>;
  return <div><h1>Dashboard</h1>{/* Use stats data */}</div>;
}
```

> **When should you choose CSR?** Pages that do not need SEO, have highly personalized data (such as user dashboards), and are not sensitive to first-screen performance. CSR's advantage is zero server rendering load, and shell HTML can be cached by a CDN.

## 4. Client Entry

```typescript
// src/entry-client.tsx
import { initNamiClient } from '@nami/client';

initNamiClient({
  containerId: 'nami-root',
  // Plugins are initialized at this stage
  // plugins: [...],
});
```

## 5. Server Entry

```typescript
// src/entry-server.tsx
import React from 'react';
import App from './app';

/**
 * Server-side rendering entry function
 * The framework calls this function on every SSR request
 */
export function createAppElement(context) {
  return <App url={context.url} initialData={context.initialData} />;
}

// Or use the renderToHTML protocol (choose one of the two)
// export async function renderToHTML(context, initialData) {
//   return renderToString(<App />);
// }
```

## 6. CLI Commands

```bash
# Development mode — HMR + live compilation + automatic server-code refresh
pnpm nami dev
# Visit http://localhost:3000
# Automatically updates after modifying page components or getServerSideProps

# Production build — builds both client and server outputs
pnpm nami build
# Outputs to dist/client/ (browser-side JS/CSS/HTML) and dist/server/ (Node-side code)

# Start the production server
pnpm nami start
# Optional --cluster enables multi-process mode (uses multiple CPU cores)

# Static page generation (SSG/ISR routes only)
pnpm nami generate
# Optional --route '/blog/:slug' generates only the specified route configuration item
# Note that the parameter matches route.path in nami.config.ts, not a concrete URL

# Bundle analysis — visualize Bundle composition to help optimize bundle size
pnpm nami analyze

# Environment information — print versions of Node, pnpm, Webpack, and others
pnpm nami info
```

> **Typical development workflow**:
> 1. `nami dev` — development and debugging
> 2. `nami build` — build production outputs
> 3. `nami start` — locally verify production behavior
> 4. Deploy to the server and start `nami start --cluster` with PM2 or K8s

## 7. Use Data in Pages

### Server-Injected Data

```typescript
import { useNamiData } from '@nami/client';

function MyComponent() {
  // Read data injected by the server into window.__NAMI_DATA__
  const data = useNamiData();
  // Or read a specific field
  const user = useNamiData<User>('user');
}
```

### Client Data Requests

```typescript
import { useClientFetch } from '@nami/client';

function ProductList() {
  const { data, loading, error, refetch } = useClientFetch<Product[]>(
    '/api/products',
    { staleTime: 30000 }, // Use the cache within 30 seconds
  );

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;
  return <ul>{data?.map(p => <li key={p.id}>{p.name}</li>)}</ul>;
}
```

## 8. Use Head Management

```tsx
import { NamiHead } from '@nami/client';

function BlogPost({ post }) {
  return (
    <>
      <NamiHead>
        <title>{post.title} - My Blog</title>
        <meta name="description" content={post.excerpt} />
        <meta property="og:title" content={post.title} />
        <link rel="canonical" href={`https://myblog.com/post/${post.slug}`} />
      </NamiHead>
      <article>...</article>
    </>
  );
}
```

## 9. Use Routing

```tsx
import { useRouter, NamiLink } from '@nami/client';

function Navigation() {
  const { path, replace, query } = useRouter();

  return (
    <nav>
      {/* NamiLink supports preloading on hover / when entering the viewport */}
      <NamiLink to="/" prefetchOnHover>Home</NamiLink>
      <NamiLink to="/about">About</NamiLink>

      {/* Programmatic navigation */}
      <button onClick={() => replace('/dashboard')}>
        Dashboard
      </button>
    </nav>
  );
}
```

## 10. Add Plugins

```typescript
// nami.config.ts
import { defineConfig } from '@nami/core';
import { NamiCachePlugin } from '@nami/plugin-cache';
import { NamiMonitorPlugin } from '@nami/plugin-monitor';

export default defineConfig({
  appName: 'my-app',
  plugins: [
    new NamiCachePlugin({
      strategy: 'lru',
      lruOptions: {
        maxSize: 100,
      },
    }),
    new NamiMonitorPlugin({
      endpoint: 'https://monitor.example.com/collect',
      errorCollectorOptions: {
        sampleRate: 0.1,
      },
    }),
  ],
});
```

---

## Next Steps

- Want to understand the framework's internal architecture? → [Architecture Design](./architecture.en.md)
- Want to learn differences between rendering modes and how to choose one? → [Five Rendering Modes](./rendering-modes.en.md)
- Want to write a custom plugin? → [Plugin System](./plugin-system.en.md)
