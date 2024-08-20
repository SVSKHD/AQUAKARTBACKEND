import swaggerAutogen from "swagger-autogen";

// Swagger configuration
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

// Function to generate Swagger documentation
const generateSwaggerDocs = async () => {
  try {
    await swaggerAutogen()(outputFile, endpointsFiles);
    console.log("Swagger documentation generated.");
  } catch (error) {
    console.error("Error generating Swagger documentation:", error);
  }
};

export default generateSwaggerDocs;
