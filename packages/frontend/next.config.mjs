/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  experimental: {
    // `@mysten-incubation/memwal` is an optional peer dep, gated at runtime
    // by `MEMWAL_PEERDEP_ENABLED`. Keep it out of the webpack bundle so
    // builds without the package installed succeed.
    serverComponentsExternalPackages: ['@mysten-incubation/memwal'],
  },
  webpack: (config, { webpack, isServer }) => {
    if (!isServer) {
      config.plugins.push(
        new webpack.IgnorePlugin({
          resourceRegExp: /^@mysten-incubation\/memwal$/,
        }),
      );
    }
    config.resolve.fallback = { fs: false, net: false, tls: false };
    return config;
  },
};

export default config;
