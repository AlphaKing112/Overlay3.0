import nextConfig from "eslint-config-next";

const eslintConfig = [
  ...nextConfig,
  {
    rules: {
      "@next/next/no-img-element": "off", // Disabled to avoid Vercel image optimization costs
    },
  },
];

export default eslintConfig;
