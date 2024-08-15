import swaggerAutogen from "swagger-autogen";

const doc = {
  info: {
    title: "Aquakart API",
    description: "API documentation for Aquakart",
    version: "1.0.0",
  },
  servers: [
    {
      url: "http://localhost:5300",
      description: "Local development server",
    },
    {
      url: "https://api.aquakart.co.in",
      description: "Production server",
    },
  ],
};

const outputFile = "./swagger-output.json"; // Output file for generated documentation
const endpointsFiles = ["./app.js"]; // File where your endpoints are defined

// Run swagger-autogen
swaggerAutogen()(outputFile, endpointsFiles).then(async () => {
  // After the documentation is generated, dynamically import the app.js module
  const { default: app } = await import("./app.js"); // Dynamically import your app.js
  app(); // This will start the app
});
