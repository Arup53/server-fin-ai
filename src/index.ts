import express, { query } from "express";
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
import { promise, z } from "zod";
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
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { Redis } from "@upstash/redis";
import { PrismaClient } from "@prisma/client";

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const prisma = new PrismaClient();

app.use(express.json());
app.use(cors());
// Initialize Redis Client
const redis = new Redis({
  url: process.env.REDIS_URL,
  token: process.env.REDIS_PASSWORD,
});

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

  const namespace = "foo";

  const stats = await pineconeIndex.describeIndexStats();
  const namespaces = Object.keys(stats.namespaces || {});

  const exists = namespaces.includes(namespace);

  console.log(exists);

  const vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
    pineconeIndex,
    // Maximum number of batch requests to allow at once. Each batch is 1000 vectors.
    maxConcurrency: 5,
    // You can pass a namespace here too
    namespace: namespace,
  });

  if (!exists) {
    await vectorStore.addDocuments(allSplits);
  }

  const retriever = vectorStore.asRetriever({
    k: 10,
    searchType: "similarity", // number of results
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

const pdf = "./pdf/binance-coin-whitepaper.pdf";

// ------------ rag --------------
const namespace = "crypto";
async function ragDataIngestion() {
  const loader = new PDFLoader(pdf);
  const docs = await loader.load();

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 500,
    chunkOverlap: 50,
  });

  const allSplits = await splitter.splitDocuments(docs);
  console.log(allSplits.length);

  const pinecone = new PineconeClient();
  const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX!);

  const stats = await pineconeIndex.describeIndexStats();
  const namespaces = Object.keys(stats.namespaces || {});

  // const exists = namespaces.includes(namespace);

  // console.log(exists);

  const vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
    pineconeIndex,
    // Maximum number of batch requests to allow at once. Each batch is 1000 vectors.
    maxConcurrency: 5,
    // You can pass a namespace here too
    namespace: namespace,
  });

  // if (!exists) {
  //   await vectorStore.addDocuments(allSplits);
  // }
}

// app.post("/ragPdf", async function (req, res) {
//   const query = req.body.query;
//   console.log(query);
// });

// async function rag() {
//   const pinecone = new PineconeClient();
//   const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX!);

//   const vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
//     pineconeIndex,
//     // Maximum number of batch requests to allow at once. Each batch is 1000 vectors.
//     maxConcurrency: 5,
//     // You can pass a namespace here too
//     namespace: namespace,
//   });

//   const retriever = vectorStore.asRetriever({
//     k: 5,
//     searchType: "similarity", // number of results
//   });

//   const customTemplate = `Use the following pieces of context to answer the question at the end.
//   If you don't know the answer, just say that you don't know, don't try to make up an answer.

//   Always say "thanks for asking!" at the end of the answer.

//   {context}

//   Question: {question}

//   Answer:`;

//   const customRagPrompt = PromptTemplate.fromTemplate(customTemplate);

//   const customRagChain = await createStuffDocumentsChain({
//     llm: llm,
//     prompt: customRagPrompt,
//     outputParser: new StringOutputParser(), // output result as string
//   });

//   const query = "what are crypto exchanges problems:";

//   const userQuery = query;

//   const context = await retriever.invoke(userQuery);

//   const result = await customRagChain.invoke({
//     question: userQuery,
//     context,
//   });

//   console.log(result);
// }

// ----------RAG CHAT ENDPOINT---------

app.post("/ragChat", async (req, res) => {
  const query = req.body.query;
  console.log(query);
  const pinecone = new PineconeClient();
  const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX!);

  const vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
    pineconeIndex,
    // Maximum number of batch requests to allow at once. Each batch is 1000 vectors.
    maxConcurrency: 5,
    // You can pass a namespace here too
    namespace: namespace,
  });

  const retriever = vectorStore.asRetriever({
    k: 5,
    searchType: "similarity", // number of results
  });

  const customTemplate = `Use the following pieces of context to answer the question at the end.
  If you don't know the answer, just say that you don't know, don't try to make up an answer.
 
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

  // const query = "what are crypto exchanges problems:";

  // const userQuery = query;

  const context = await retriever.invoke(query);

  const result = await customRagChain.invoke({
    question: query,
    context,
  });

  console.log(result);
  res.send(result);
});

// -------------- REDIS CACHED API FOR PAGINATION-------------
// @ts-ignore
const COINS_CACHE_KEY = "all-coins"; // Key for storing full data
const CACHE_EXPIRATION = 600; // Cache expiration in seconds (10 minutes)

// Function to fetch and cache full CoinGecko data
const fetchAndCacheCoins = async () => {
  try {
    console.log("Fetching full CoinGecko data...");
    const response = await axios.get(
      "https://api.coingecko.com/api/v3/coins/markets",
      {
        params: {
          vs_currency: "usd",
          order: "market_cap_desc",
          per_page: 250, // Max items per request
          page: 1, // Start from page 1
        },
        headers: {
          accept: "application/json",
        },
      }
    );

    let allCoins = response.data;

    // Fetch additional pages if needed
    for (let i = 2; i <= 4; i++) {
      const additionalData = await axios.get(
        "https://api.coingecko.com/api/v3/coins/markets",
        {
          params: {
            vs_currency: "usd",
            order: "market_cap_desc",
            per_page: 250, // Max items per request
            page: i, // Next page
          },
          headers: {
            accept: "application/json",
          },
        }
      );
      allCoins = [...allCoins, ...additionalData.data];
    }

    // Store full dataset in Redis
    await redis.set(COINS_CACHE_KEY, JSON.stringify(allCoins), {
      ex: CACHE_EXPIRATION,
    });

    console.log("Coin data cached successfully!");
  } catch (error) {
    console.error("Error fetching CoinGecko data:", error);
  }
};

// Route to serve paginated coins from cache
app.get("/coins", async (req, res) => {
  try {
    const { page = 1, item = 10 } = req.query;
    // @ts-ignore
    const pageNumber = parseInt(page, 10);
    // @ts-ignore
    const itemsPerPage = parseInt(item, 10);

    // Check if full data exists in cache
    let cachedData = await redis.get(COINS_CACHE_KEY);
    if (!cachedData) {
      console.log("Cache empty, fetching fresh data...");
      await fetchAndCacheCoins();
      cachedData = await redis.get(COINS_CACHE_KEY);
    }

    // Parse data
    // @ts-ignore
    let allCoins;
    try {
      allCoins =
        typeof cachedData === "string" ? JSON.parse(cachedData) : cachedData;
    } catch (error) {
      console.error("Error parsing JSON from Redis:", error);
      allCoins = []; // Fallback if parsing fails
    }

    // Paginate data
    const startIndex = (pageNumber - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const paginatedData = allCoins.slice(startIndex, endIndex);

    res.json({
      // totalItems: allCoins.length,
      // totalPages: Math.ceil(allCoins.length / itemsPerPage),
      // currentPage: pageNumber,
      // perPage: itemsPerPage,
      coins: paginatedData,
    });
  } catch (error) {
    console.error("Error fetching paginated data:", error);
    res.status(500).json({ error: "Failed to fetch data" });
  }
});

// Fetch and cache data on server start
fetchAndCacheCoins();

// Refresh cache every 10 minutes
setInterval(fetchAndCacheCoins, CACHE_EXPIRATION * 1000);

// ------------------Trending & Market cap  api -----------------

interface PriceChangePercentage {
  [key: string]: number;
}

interface CoinData {
  price_change_percentage_24h: PriceChangePercentage;
}

interface CoinItem {
  id: string;
  coin_id: number;
  name: string;
  symbol: string;
  market_cap_rank?: number;
  thumb: string;
  small: string;
  large: string;
  slug: string;
  price_btc: number;
  score: number;
  data: CoinData; // Now explicitly typed
}

interface TrendingCoin {
  item: CoinItem;
}

interface TrendingCoinsResponse {
  coins: TrendingCoin[];
}

async function fetchCoinAndMarketCap() {
  const resCoin = await axios.get<TrendingCoinsResponse>(
    "https://api.coingecko.com/api/v3/search/trending",
    {
      headers: {
        "Content-Type": "application/json",
      },
    }
  );

  const newArr: TrendingCoin[] = resCoin.data.coins.slice(0, 3);

  const resMarket = await axios.get("https://api.coingecko.com/api/v3/global");
  const obj = {
    marketCap: resMarket.data.data.total_market_cap.usd,
    change: resMarket.data.data.market_cap_change_percentage_24h_usd,
  };

  console.log(obj);
  await insertCoinAndMarketInfo(newArr, obj);
}

async function insertCoinAndMarketInfo(
  coinArr: TrendingCoin[],
  marketObj: any
) {
  return await prisma.$transaction(async (tx) => {
    await tx.trending.deleteMany();
    await tx.marketCap.deleteMany();

    const coinInsert = await Promise.all(
      coinArr.map((coin: TrendingCoin) =>
        tx.trending.create({
          data: {
            name: coin.item.name,
            image: coin.item.small,
            change: coin.item.data.price_change_percentage_24h.usd,
          },
        })
      )
    );

    const marketCapInsert = await tx.marketCap.create({
      data: {
        capital: marketObj.marketCap,
        change: marketObj.change,
      },
    });
    return { coinInsert, marketCapInsert };
  });
}

setInterval(fetchCoinAndMarketCap, 30 * 60 * 1000);

app.get("/marketStats", async (req, res) => {
  try {
    const [trendingData, marketCapData] = await Promise.all([
      prisma.trending.findMany(),
      prisma.marketCap.findMany(),
    ]);
    console.log(trendingData, marketCapData);
    res.json({ trending: trendingData, marketCap: marketCapData });
  } catch (error) {
    console.error("Error fetching market stats:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
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
