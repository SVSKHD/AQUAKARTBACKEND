import { StandardCheckoutClient, Env } from "pg-sdk-node";

let client = null;

const getPhonePeClient = () => {
  if (!client) {
    client = StandardCheckoutClient.getInstance(
      process.env.PHONEPE_CLIENT_ID,
      process.env.PHONEPE_CLIENT_SECRET,
      parseInt(process.env.PHONEPE_CLIENT_VERSION),
      process.env.PHONEPE_ENV === "PRODUCTION" ? Env.PRODUCTION : Env.SANDBOX,
    );
  }
  return client;
};

export default getPhonePeClient;
