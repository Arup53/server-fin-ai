-- CreateTable
CREATE TABLE "Trending" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "change" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trending_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketCap" (
    "id" SERIAL NOT NULL,
    "capital" DOUBLE PRECISION,
    "change" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketCap_pkey" PRIMARY KEY ("id")
);
