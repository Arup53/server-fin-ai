import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";

import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

import { ChatGroq } from "@langchain/groq";
import {
  AgentExecutor,
  createToolCallingAgent,
  createOpenAIToolsAgent,
} from "langchain/agents";
import {
  tool,
  DynamicStructuredTool,
  DynamicTool,
} from "@langchain/core/tools";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { z } from "zod";
import RSI from "calc-rsi";
import axios from "axios";
import "cheerio";
import { CheerioWebBaseLoader } from "@langchain/community/document_loaders/web/cheerio";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { PineconeStore } from "@langchain/pinecone";
import { Pinecone as PineconeClient } from "@pinecone-database/pinecone";
import { PromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { createStuffDocumentsChain } from "langchain/chains/combine_documents";
import { MistralAIEmbeddings } from "@langchain/mistralai";

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(cors());
const port = 3000;

const llm = new ChatGroq({
  apiKey: process.env.GROQ_API_KEY,
  model: "llama-3.3-70b-versatile",
  temperature: 0,
});

const embeddings = new MistralAIEmbeddings({
  model: "mistral-embed",
  apiKey: process.env.MISTRAL_API_KEY,
});

app.get("/", (req, res) => {
  res.send("Hello, how ussss");
});

app.post("/user", async (req, res) => {
  const body = req.body.input;

  async function analyzeSentiment(textArr: any) {
    const chat = new ChatGroq({
      apiKey: process.env.GROQ_API_KEY,
      model: "llama-3.3-70b-versatile", // Replace with your desired model
      temperature: 0,
    }).bind({
      response_format: { type: "json_object" },
    });
    // Create a prompt that instructs the model to analyze the sentiment of each text
    const prompt = `Analyze the sentiment of the following texts,find  which tone is greater and Return the larger tone as a JSON object with keys 'sentiment with value POSTIVIE OR NEGATIVE and key 'confidence' with value 0-100:
  
    ${textArr
      .map((text: string, index: any) => `${index + 1}. "${text}"`)
      .join("\n")}
  
    `;

    const response = await chat.invoke([
      { role: "system", content: "You are a sentiment analysis assistant." },
      { role: "user", content: prompt },
    ]);

    // Process the response to extract sentiment information
    // This will depend on the structure of the response from the Groq model
    // For example:

    const sentiment = response.content; // Adjust based on actual response structure
    console.log(sentiment);
    return sentiment;
  }

  const sentimentTool = new DynamicTool({
    name: "crypto_market_sentiment",
    description: "Provide crypto market sentiment live",
    func: async () => {
      try {
        // Fetch news articles
        const newsResponse = await axios.get(
          `https://newsapi.org/v2/everything?q=crypto market sentiment&from=2025-1-30&sortBy=publishedAt&language=en&apiKey=${process.env.NEWS_API_KEY}`
        );

        // Process articles and filter empty descriptions
        const textArr = newsResponse.data.articles
          .slice(0, 50)
          .map((article: any) => article.description)
          .filter((description: any) => description);

        console.log(textArr);
        // Perform sentiment analysis
        const sentiments = await analyzeSentiment(textArr);

        // Output the sentiments
        return sentiments;
      } catch (error) {
        console.error("Error:", error);
      }
    },
  });

  const realTimeMarketDataTool = new DynamicStructuredTool({
    name: "real_time_market_data",
    description:
      "Fetch real-time cryptocurrency market data for specific coin(s). Accepts comma-separated CoinGecko IDs (e.g., 'bitcoin,ethereum,solana').",
    schema: z.object({
      coinIds: z
        .string()
        .describe("Comma-separated CoinGecko IDs (e.g., 'bitcoin,ethereum')"),
    }),
    func: async ({ coinIds }) => {
      try {
        const response = await axios.get(
          `https://api.coingecko.com/api/v3/simple/price?ids=${coinIds}&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true`
        );
        return JSON.stringify(response.data);
      } catch (error) {
        return "Unable to fetch real-time market data. Please check the coin IDs and try again.";
      }
    },
  });

  function sixMonthMovingAverage(data: any, period: any) {
    let result = [];
    for (let i = 0; i <= data.length - period; i++) {
      let window = data.slice(i, i + period);
      let sum = window.reduce((acc: any, val: any) => acc + val, 0);
      result.push(sum / period);
    }
    return result;
  }

  const technicalIndicatorsTool = new DynamicStructuredTool({
    name: "technical_indicators",
    description:
      "Calculate technical indicators (RSI, MACD, Moving Averages) for a given cryptocurrency for specific coin(s). Accepts comma-separated CoinGecko IDs (e.g., 'bitcoin,ethereum,solana etc').",
    schema: z.object({
      coinIds: z
        .string()
        .describe("Comma-separated CoinGecko IDs (e.g., 'bitcoin,ethereum')"),
    }),
    func: async ({ coinIds }) => {
      const historicalData = await axios.get(
        `https://api.coingecko.com/api/v3/coins/${coinIds}/market_chart?vs_currency=usd&days=30&interval=daily`
      );
      let finalOutput;
      // Extract closing prices
      const closingPrices = historicalData.data.prices.map(
        (price: any) => price[1]
      );

      const rsi = new RSI(closingPrices, 14);
      const result = rsi.calculate((err: any, result: any) => {
        if (err) {
          return err;
        }

        const latestRSI = JSON.stringify(result[result.length - 1].rsi);
        const sma = JSON.stringify(sixMonthMovingAverage(closingPrices, 20));

        finalOutput = `Latest_RSI: ${latestRSI} and Six_Month_Moving_Average: ${sma}`;
      });
      console.log(finalOutput);
      return finalOutput;
    },
  });

  const prompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      `You are a crypto market advisor. Follow these steps if user query on crypto market:
      1. Identify which cryptocurrency(ies) the user is asking about
      2. Use appropriate tools to gather data for those specific coins
      3. Always mention the tools you used and their results (sentimenttool will provide overall market sentiment not specific coin sentiment note that)
      4. Provide clear advice based on the collected data and do not say do your own research
      
      Example coin IDs: bitcoin, ethereum, solana, dogecoin
      else answer that : Sorry, I can not answer general query as I am a crypto market advisor
      `,
    ],
    ["human", "{input}"],
    ["placeholder", "{agent_scratchpad}"],
  ]);

  const tools = [
    realTimeMarketDataTool,
    technicalIndicatorsTool,
    sentimentTool,
  ];
  const agent = await createOpenAIToolsAgent({
    llm: llm,
    tools,
    prompt,
  });

  const executor = new AgentExecutor({
    agent,
    tools,
  });

  const userInput = body;
  console.log(userInput.toLowerCase());
  // Execute the agent with the input
  const result = await executor.invoke({ input: userInput });
  // Output the result
  console.log(result);

  res.send({ result });
});

app.post("/chatRag", async (req, res) => {
  const query = req.body.query;
  console.log(query);

  const pTagSelector = "p";
  const cheerioLoader = new CheerioWebBaseLoader(
    "https://lilianweng.github.io/posts/2023-06-23-agent/",
    {
      selector: pTagSelector,
    }
  );

  const docs = await cheerioLoader.load();

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });
  const allSplits = await splitter.splitDocuments(docs);
  console.log(allSplits.length);

  const pinecone = new PineconeClient();
  const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX!);

  const vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
    pineconeIndex,
    // Maximum number of batch requests to allow at once. Each batch is 1000 vectors.
    maxConcurrency: 5,
    // You can pass a namespace here too
    // namespace: "foo",
  });

  await vectorStore.addDocuments(allSplits);

  const retriever = vectorStore.asRetriever({
    k: 5, // number of results
  });

  // const res = await retriever.invoke("What is Task Decomposition?");
  // console.log(res);

  const customTemplate = `Use the following pieces of context to answer the question at the end.
If you don't know the answer, just say that you don't know, don't try to make up an answer.
Use three sentences maximum and keep the answer as concise as possible.
Always say "thanks for asking!" at the end of the answer.

{context}

Question: {question}

Answer:`;

  const customRagPrompt = PromptTemplate.fromTemplate(customTemplate);

  const customRagChain = await createStuffDocumentsChain({
    llm: llm,
    prompt: customRagPrompt,
    outputParser: new StringOutputParser(), // output result as string
  });

  const userQuery = query;

  const context = await retriever.invoke(userQuery);

  const result = await customRagChain.invoke({
    question: userQuery,
    context,
  });

  console.log(result);

  res.send(result);
});

// WebSocket Connection
// const symbols = [
//   "btcusdt",
//   "ethusdt",
//   "bnbusdt",
//   "solusdt",
//   "xrpusdt",
//   "dogeusdt",
//   "dotusdt",
// ]; // Add up to 20 symbols
// const url = `wss://stream.binance.com:9443/ws/${symbols
//   .map((s) => `${s}@trade`)
//   .join("/")}`;

// let binanceSocket = new WebSocket(url);

// // Broadcast function
// const broadcast = (data: any) => {
//   wss.clients.forEach((client: any) => {
//     if (client.readyState === WebSocket.OPEN) {
//       client.send(JSON.stringify(data));
//     }
//   });
// };

// // Handle Binance WebSocket events
// binanceSocket.onmessage = (event) => {
//   const data = JSON.parse(event.data);

//   const priceUpdate = {
//     symbol: data.s,
//     price: parseFloat(data.p),
//   };

//   broadcast(priceUpdate);
// };

// binanceSocket.onclose = () => {
//   console.log("Binance WebSocket closed. Reconnecting...");
//   setTimeout(() => {
//     binanceSocket = new WebSocket(url);
//   }, 5000);
// };

// wss.on("connection", (ws: any) => {
//   console.log("Client connected");
//   ws.send(JSON.stringify({ message: "Connected to Binance Ticker!" }));
// });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
