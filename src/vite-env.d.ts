/// <reference types="vite/client" />

/** App version injected from package.json at build time. */
declare const __APP_VERSION__: string;
/** True only in a preview build made with PREVIEW_DEMO_N01=1 (n01 answered from demo data). */
declare const __PREVIEW_DEMO_N01__: boolean;
