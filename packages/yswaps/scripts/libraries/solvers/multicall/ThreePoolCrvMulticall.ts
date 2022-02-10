import { BigNumber, constants, PopulatedTransaction, Signer, utils } from 'ethers';
import { ExtendedEnabledTrade, IMulticallSolver, TradeSetup } from '@scripts/libraries/types';
import { ICurveFi, ICurveFi__factory, IERC20, IERC20__factory, IVault, IVault__factory, TradeFactory } from '@typechained';
import zrx from '@libraries/dexes/zrx';
import { mergeTransactions } from '@scripts/libraries/utils/multicall';
import { impersonate } from '@test-utils/wallet';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

// 1) 3pool => [usdc|usdt|dai]
// 2) [usdc|usdt|dai] => yvBOOST
// 3) yvBOOST withdraw  => yveCRV

export class ThreePoolCrvMulticall implements IMulticallSolver {
  private threeCrv = '0x6c3F90f043a72FA612cbac8115EE7e52BDe6E490';
  private yveCrv = '0xc5bDdf9843308380375a611c18B50Fb9341f502A';
  private yvBoost = '0x9d409a0A012CFbA9B15F6D4B36Ac57A46966Ab9a';
  private strategy = '0x91C3424A608439FBf3A91B6d954aF0577C1B9B8A';
  private crv3Pool = '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7';
  private usdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  private multicallSwapper = '0xceB202F25B50e8fAF212dE3CA6C53512C37a01D2';
  private zrxContract = '0xDef1C0ded9bec7F1a1670819833240f027b25EfF';

  async solve(trade: ExtendedEnabledTrade, tradeFactory: TradeFactory): Promise<TradeSetup> {
    const strategySigner = await impersonate(this.strategy);
    const multicallSwapperSigner = await impersonate(this.multicallSwapper);
    const crv3Pool = ICurveFi__factory.connect(this.crv3Pool, multicallSwapperSigner);
    const threeCrv = IERC20__factory.connect(this.threeCrv, strategySigner);
    const usdc = IERC20__factory.connect(this.usdc, multicallSwapperSigner);
    const yvBoostToken = IERC20__factory.connect(this.yvBoost, multicallSwapperSigner);
    const yvBoostVault = IVault__factory.connect(this.yvBoost, multicallSwapperSigner);
    const yveCrvToken = IERC20__factory.connect(this.yveCrv, multicallSwapperSigner);

    const amount = await threeCrv.balanceOf(trade._strategy);
    console.log('[ThreePoolCrvMulticall] 3crv transfer to swapper');
    await threeCrv.transfer(this.multicallSwapper, amount);

    // Withdraw usdc from crv3Pool
    console.log('[ThreePoolCrvMulticall] Remove liqudity from curve pool');
    const usdcBalancePre = await usdc.balanceOf(this.multicallSwapper);
    await crv3Pool.remove_liquidity_one_coin(amount, 1, 0);
    const usdcBalanceTotal = await usdc.balanceOf(this.multicallSwapper);
    let usdcBalance = usdcBalanceTotal.sub(usdcBalancePre);
    if (usdcBalanceTotal.eq(usdcBalance)) {
      // we need to leave at least 1 wei as dust for gas optimizations
      usdcBalance = usdcBalance.sub(1);
    }
    console.log(
      '[ThreePoolCrvMulticall] Total USDC after removing liquidity form curve pool',
      utils.formatUnits(usdcBalance, 6),
      `(raw: ${usdcBalance.toString()})`
    );

    // Trade USDC for yvBOOST in zrx
    const { data: zrxData, allowanceTarget: zrxAllowanceTarget } = await zrx.quote({
      chainId: 1,
      sellToken: this.usdc,
      buyToken: this.yvBoost,
      sellAmount: usdcBalance,
      slippagePercentage: 10 / 100,
    });

    console.log('[ThreePoolCrvMulticall] Got quote from ZRX');

    const tx = {
      to: this.zrxContract,
      data: zrxData,
    };

    const approveUsdc = (await usdc.allowance(this.multicallSwapper, zrxAllowanceTarget)) < usdcBalance;
    if (approveUsdc) {
      console.log('[ThreePoolCrvMulticall] Approving usdc');
      await usdc.approve(zrxAllowanceTarget, constants.MaxUint256);
    }

    console.log('[ThreePoolCrvMulticall] Executing ZRX swap');
    await multicallSwapperSigner.sendTransaction(tx);

    const yvBoostBalance: BigNumber = await yvBoostToken.balanceOf(this.multicallSwapper);
    console.log('[ThreePoolCrvMulticall] yvBOOST after swap: ', utils.formatEther(yvBoostBalance), `(raw: ${yvBoostBalance.toString()})`);

    console.log('[ThreePoolCrvMulticall] Withdrawing yvBOOST');
    await yvBoostVault.withdraw(constants.MaxUint256, this.multicallSwapper, 0);

    const yveCrvBalance: BigNumber = await yveCrvToken.balanceOf(this.multicallSwapper);
    console.log('[ThreePoolCrvMulticall] yveCRV after withdraw', utils.formatEther(yveCrvBalance), `(raw: ${yveCrvBalance.toString()})`);

    // Create txs for multichain swapper
    const transactions: PopulatedTransaction[] = [];

    // 1) Withdraw usdc from 3pool
    transactions.push(await crv3Pool.populateTransaction.remove_liquidity_one_coin(amount, 1, 0));

    // 2) Approve usdc in zrx (if neccesary)
    if (approveUsdc) transactions.push(await usdc.populateTransaction.approve(zrxAllowanceTarget, constants.MaxUint256));

    // 3) Swap usdc for yvBOOST
    transactions.push(tx);

    // 4) Withdraw from yvBOOST
    transactions.push(await yvBoostVault.populateTransaction.withdraw(constants.MaxUint256, this.strategy, BigNumber.from('0')));

    const data: string = mergeTransactions(transactions);

    console.log('[ThreePoolCrvMulticall] Data after merging transactions:', data);

    const executeTx = await tradeFactory.populateTransaction['execute((address,address,address,uint256,uint256),address,bytes)'](
      {
        _strategy: trade._strategy,
        _tokenIn: trade._tokenIn,
        _tokenOut: trade._tokenOut,
        _amount: amount,
        _minAmountOut: yveCrvBalance,
      },
      this.multicallSwapper,
      data
    );

    return {
      swapperName: 'ThreePoolCrvMulticall',
      transaction: executeTx,
    };
  }

  match(trade: ExtendedEnabledTrade) {
    return trade._strategy == this.strategy && trade._tokenIn == this.threeCrv && trade._tokenOut == this.yveCrv;
  }
}