import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from "dotenv"

const app = express();

// Middleware
app.use(bodyParser.json());
app.use(cors());
app.use(morgan('dev'));
dotenv.config()
// Basic route
app.get('/', (req, res) => {
  res.json({"status":'Hello Aquakart'});
});

const PORT = process.env.PORT
// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
