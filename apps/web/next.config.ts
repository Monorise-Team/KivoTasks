import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Kontener na AWS albo serwer Node: jeden katalog z serwerem i zależnościami (ADR-0096)
  output: "standalone",
  serverExternalPackages: ["pg"],
  experimental: {
    globalNotFound: true,
    // Next 16 buforuje treść żądań przechodzących przez src/proxy.ts i po cichu ucina powyżej 10 MB;
    // limit musi być większy niż KIVOTASKS_ATTACHMENT_MAX_BYTES plus narzut multipart.
    proxyClientMaxBodySize: "27mb",
  },
  poweredByHeader: false,
  // Znaczek trybu deweloperskiego w prawym dolnym rogu, żeby nie zasłaniał przycisku zwijania paska bocznego
  devIndicators: { position: "bottom-right" },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
