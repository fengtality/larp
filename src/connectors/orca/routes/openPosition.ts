import { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { PublicKey } from '@solana/web3.js';
import {
  PDAUtil, PriceMath, increaseLiquidityQuoteByInputTokenWithParams,
  TokenExtensionUtil, ORCA_WHIRLPOOL_PROGRAM_ID
} from "@orca-so/whirlpools-sdk";
import { DecimalUtil, Percentage } from "@orca-so/common-sdk";
import Decimal from "decimal.js";
import { OrcaController } from '../orca.controller';

// devnet config for Orca
const DEVNET_WHIRLPOOLS_CONFIG = new PublicKey("FcrweFY1G9HJAHG5inkGB6pKg1HZ6x9UC2WioAfWrGkR");

class OpenPositionController extends OrcaController {
  async openPosition(
    baseTokenAddress: string,
    quoteTokenAddress: string,
    tickSpacing: number,
    lowerPrice: Decimal,
    upperPrice: Decimal,
    quoteTokenAmount: number,
    slippagePct?: number
  ): Promise<{ signature: string; positionMint: string }> {
    await this.loadOrca();

    // Get devSAMO/devUSDC whirlpool
    const whirlpool_pubkey = PDAUtil.getWhirlpool(
      ORCA_WHIRLPOOL_PROGRAM_ID,
      DEVNET_WHIRLPOOLS_CONFIG,
      new PublicKey(baseTokenAddress),
      new PublicKey(quoteTokenAddress),
      tickSpacing
    ).publicKey;
    console.log("whirlpool_key:", whirlpool_pubkey.toBase58());
    const whirlpool = await this.client.getPool(whirlpool_pubkey);

    // Get the current price of the pool
    const sqrt_price_x64 = whirlpool.getData().sqrtPrice;
    const token_a = whirlpool.getTokenAInfo();
    const token_b = whirlpool.getTokenBInfo();
    const price = PriceMath.sqrtPriceX64ToPrice(sqrt_price_x64, token_a.decimals, token_b.decimals);
    console.log("price:", price.toFixed(token_b.decimals));

    // Set price range, amount of tokens to deposit, and acceptable slippage
    const quote_token_amount = DecimalUtil.toBN(new Decimal(quoteTokenAmount.toString()), token_b.decimals);
    const slippage = slippagePct
      ? Percentage.fromFraction(slippagePct * 100, 10000)
      : Percentage.fromFraction(10, 1000); // Default 1% slippage

    // Adjust price range
    const whirlpool_data = whirlpool.getData();
    const lower_tick_index = PriceMath.priceToInitializableTickIndex(lowerPrice, token_a.decimals, token_b.decimals, whirlpool_data.tickSpacing);
    const upper_tick_index = PriceMath.priceToInitializableTickIndex(upperPrice, token_a.decimals, token_b.decimals, whirlpool_data.tickSpacing);
    console.log("lower & upper tick_index:", lower_tick_index, upper_tick_index);
    console.log("lower & upper price:",
      PriceMath.tickIndexToPrice(lower_tick_index, token_a.decimals, token_b.decimals).toFixed(token_b.decimals),
      PriceMath.tickIndexToPrice(upper_tick_index, token_a.decimals, token_b.decimals).toFixed(token_b.decimals)
    );

    // Obtain deposit estimation
    const quote = increaseLiquidityQuoteByInputTokenWithParams({
      tokenMintA: token_a.mint,
      tokenMintB: token_b.mint,
      sqrtPrice: whirlpool_data.sqrtPrice,
      tickCurrentIndex: whirlpool_data.tickCurrentIndex,
      tickLowerIndex: lower_tick_index,
      tickUpperIndex: upper_tick_index,
      inputTokenMint: token_b.mint,
      inputTokenAmount: quote_token_amount,
      slippageTolerance: slippage,
      tokenExtensionCtx: await TokenExtensionUtil.buildTokenExtensionContext(this.ctx.fetcher, whirlpool_data),
    });

    // Output the estimation
    console.log("Token A max input:", DecimalUtil.fromBN(quote.tokenMaxA, token_a.decimals).toFixed(token_a.decimals));
    console.log("Token B max input:", DecimalUtil.fromBN(quote.tokenMaxB, token_b.decimals).toFixed(token_b.decimals));

    // Create a transaction
    const open_position_tx = await whirlpool.openPositionWithMetadata(
      lower_tick_index,
      upper_tick_index,
      quote
    );

    // Send the transaction
    const signature = await open_position_tx.tx.buildAndExecute();
    console.log("signature:", signature);
    console.log("position NFT:", open_position_tx.positionMint.toBase58());

    // Wait for the transaction to complete
    const latest_blockhash = await this.ctx.connection.getLatestBlockhash();
    await this.ctx.connection.confirmTransaction({signature, ...latest_blockhash}, "confirmed");

    return {
      signature,
      positionMint: open_position_tx.positionMint.toBase58(),
    };
  }
}

export default function openPositionRoute(fastify: FastifyInstance, folderName: string) {
  const controller = new OpenPositionController();

  fastify.post(`/${folderName}/open-position`, {
    schema: {
      tags: [folderName],
      description: 'Open a new Orca position',
      body: Type.Object({
        baseTokenAddress: Type.String({ default: 'Jd4M8bfJG3sAkd82RsGWyEXoaBXQP7njFzBwEaCTuDa' }),
        quoteTokenAddress: Type.String({ default: 'BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k' }),
        tickSpacing: Type.Number({ default: 64 }),
        lowerPrice: Type.String({ default: '0.005' }),
        upperPrice: Type.String({ default: '0.02' }),
        quoteTokenAmount: Type.Number({ default: 1 }),
        slippagePct: Type.Optional(Type.Number({ default: 1 })),
      }),
      response: {
        200: Type.Object({
          signature: Type.String(),
          positionMint: Type.String(),
        })
      }
    },
    handler: async (request, reply) => {
      const { baseTokenAddress, quoteTokenAddress, tickSpacing, lowerPrice, upperPrice, quoteTokenAmount, slippagePct } = request.body as {
        baseTokenAddress: string;
        quoteTokenAddress: string;
        tickSpacing: number;
        lowerPrice: string;
        upperPrice: string;
        quoteTokenAmount: number;
        slippagePct?: number;
      };
      fastify.log.info(`Opening new Orca position: ${baseTokenAddress}/${quoteTokenAddress}`);
      const result = await controller.openPosition(
        baseTokenAddress,
        quoteTokenAddress,
        tickSpacing,
        new Decimal(lowerPrice),
        new Decimal(upperPrice),
        quoteTokenAmount,
        slippagePct
      );
      return result;
    }
  });
}