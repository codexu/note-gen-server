import type { NextConfig } from "next"
import { networkInterfaces } from "node:os"

const allowedDevOrigins = new Set(["127.0.0.1", "localhost"])

for (const addresses of Object.values(networkInterfaces())) {
  for (const address of addresses ?? []) {
    if (address.family === "IPv4" && !address.internal) {
      allowedDevOrigins.add(address.address)
    }
  }
}

const nextConfig: NextConfig = {
  allowedDevOrigins: [...allowedDevOrigins],
  output: "export",
  trailingSlash: true,
}

export default nextConfig
