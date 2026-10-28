import swaggerAutogen from "swagger-autogen";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { applyCategoryDocs } from "./src/docs/categories.js";
import { applyRouteGroups } from "./src/docs/routeGroups.js";
import { applyCrmAiDocs } from "./src/docs/crmAi.js";
import { applyCrmCustomerAiDocs } from "./src/docs/crmCustomerAi.js";
import { applyStorefrontDocs } from "./src/docs/storefront.js";

// Swagger configuration
// const doc = {
//   info: {
//     title: 'Aquakart API',
//     description: 'API documentation for Aquakart',
//     version: '1.0.0',
//   },
//   servers: [
//     {
//       url: 'http://localhost:5300',
//       description: 'Local development server',
//     },
//     {
//       url: 'https://api.aquakart.co.in',
//       description: 'Production server',
//     },
//   ],
// };

const outputFile = fileURLToPath(
  new URL("./swagger-output.json", import.meta.url),
).replaceAll("\\", "/");
const endpointsFiles = [
  fileURLToPath(new URL("./app.js", import.meta.url)).replaceAll("\\", "/"),
];

// Function to generate Swagger documentation
const generateSwaggerDocs = async () => {
  try {
    const result = await swaggerAutogen()(outputFile, endpointsFiles);
    const document = JSON.parse(await fs.readFile(outputFile, "utf8"));
    await applyRouteGroups(
      applyStorefrontDocs(
        applyCrmCustomerAiDocs(applyCrmAiDocs(applyCategoryDocs(document))),
      ),
    );
    await fs.writeFile(outputFile, JSON.stringify(document, null, 2) + "\n");
    if (result?.success) {
      console.log(
        "Swagger documentation generated and grouped by route module.",
      );
    } else {
      console.warn(
        "Swagger inference failed; preserved existing endpoint contracts and refreshed route groups.",
      );
    }
  } catch (error) {
    console.error("Error generating Swagger documentation:", error);
  }
};

export default generateSwaggerDocs;
