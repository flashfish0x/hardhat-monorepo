import _ from 'lodash';
import { BigNumber, constants, PopulatedTransaction, Signer } from 'ethers';
import { ExtendedEnabledTrade, IMulticallSolver, TradeSetup } from '@scripts/libraries/types';
import { ICurveFi__factory, IERC20__factory, IWETH__factory, TradeFactory } from '@typechained';
import zrx from '@libraries/dexes/zrx';
import { mergeTransactions } from '@scripts/libraries/utils/multicall';
import { impersonate } from '@test-utils/wallet';

type Tx = {
  to: string;
  data: string;
};

// 1) crv => weth with zrx
// 2) cvx => weth with zrx
// 3) weth => eth with wrapper
// 4) eth => spell/eth with curve

export class CurveSpellEthMulticall implements IMulticallSolver {
  private crvSpellEth = '0x8282BD15dcA2EA2bDf24163E8f2781B30C43A2ef'; // might not be used
  private strategy = '0xeDB4B647524FC2B9985019190551b197c6AB6C5c';
  private curveSwap = '0x98638FAcf9a3865cd033F36548713183f6996122';
  private crv = '0xD533a949740bb3306d119CC777fa900bA034cd52';
  private cvx = '0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B';
  private weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  private multicallSwapper = '0x7F036fa7B01E7c0286AFd4c7f756dd367E90a5f8';
  private zrxContract = '0xDef1C0ded9bec7F1a1670819833240f027b25EfF';

  async solve(trade: ExtendedEnabledTrade, tradeFactory: TradeFactory): Promise<TradeSetup> {
    const strategySigner = await impersonate(this.strategy);
    const multicallSwapperSigner = await impersonate(this.multicallSwapper);
    const crvStrategy = IERC20__factory.connect(this.crv, strategySigner);
    const cvxStrategy = IERC20__factory.connect(this.cvx, strategySigner);
    const crv = IERC20__factory.connect(this.crv, multicallSwapperSigner);
    const cvx = IERC20__factory.connect(this.cvx, multicallSwapperSigner);
    const weth = IWETH__factory.connect(this.weth, multicallSwapperSigner);
    const curveSwap = ICurveFi__factory.connect(this.curveSwap, multicallSwapperSigner);

    const crvBalance = await crv.balanceOf(this.strategy);
    const cvxBalance = await cvx.balanceOf(this.strategy);

    if (crvBalance.lte(0) && cvxBalance.lte(0)) {
      throw ':shrug:';
    }

    console.log('[CurveSpellEthMulticall] cvx/crv transfer to swapper for simulations');
    await crvStrategy.transfer(this.multicallSwapper, crvBalance);
    await cvxStrategy.transfer(this.multicallSwapper, cvxBalance);

    console.log('[CurveSpellEthMulticall] Trade cvr for weth');
    const { data: zrxCvrData, allowanceTarget: zrxCrvAllowanceTarget } = await zrx.quote({
      chainId: 1,
      sellToken: crv.address,
      buyToken: weth.address,
      sellAmount: crvBalance,
      slippagePercentage: 10 / 100,
    });

    const approveCrv = (await crv.allowance(this.multicallSwapper, zrxCrvAllowanceTarget)) < crvBalance;
    if (approveCrv) await crv.approve(zrxCrvAllowanceTarget, constants.MaxUint256);

    const crvToWethTx: Tx = {
      to: this.zrxContract,
      data: zrxCvrData,
    };
    await multicallSwapperSigner.sendTransaction(crvToWethTx);

    console.log('[CurveSpellEthMulticall] Trade cvx for weth');
    const { data: zrxCvxData, allowanceTarget: zrxCvxAllowanceTarget } = await zrx.quote({
      chainId: 1,
      sellToken: cvx.address,
      buyToken: weth.address,
      sellAmount: cvxBalance,
      slippagePercentage: 10 / 100,
    });

    const approveCvx = (await crv.allowance(this.multicallSwapper, zrxCvxAllowanceTarget)) < cvxBalance;
    if (approveCvx) await cvx.approve(zrxCvxAllowanceTarget, constants.MaxUint256);

    const cvxToWethTx: Tx = {
      to: this.zrxContract,
      data: zrxCvxData,
    };
    await multicallSwapperSigner.sendTransaction(cvxToWethTx);

    console.log('[CurveSpellEthMulticall] Convert weth to eth');
    const wethBalance = await weth.balanceOf(this.multicallSwapper);
    await weth.withdraw(wethBalance);

    console.log('[CurveSpellEthMulticall] Convert weth to crvSpellEth');
    await curveSwap.add_liquidity([wethBalance, 0], 0, true, this.strategy, { value: wethBalance });

    // Create txs for multichain swapper
    const transactions: PopulatedTransaction[] = [];

    // zrx trades
    if (approveCrv) transactions.push(await crv.populateTransaction.approve(zrxCrvAllowanceTarget, constants.MaxUint256));
    transactions.push(crvToWethTx);
    if (approveCvx) transactions.push(await cvx.populateTransaction.approve(zrxCvxAllowanceTarget, constants.MaxUint256));
    transactions.push(cvxToWethTx);

    // Withdraw eth
    transactions.push(await weth.populateTransaction.withdraw(wethBalance));

    // eth -> crvSpellEth
    transactions.push(await curveSwap.populateTransaction.add_liquidity([wethBalance, 0], 0, true, this.strategy, { value: wethBalance }));

    const data: string = mergeTransactions(transactions);
    console.log('[CurveSpellEthMulticall] Data after merging transactions:', data);

    const executeTx = await tradeFactory.populateTransaction['execute((address,address,address,uint256,uint256)[],address,bytes)'](
      [
        {
          _strategy: this.strategy,
          _tokenIn: this.crv,
          _tokenOut: trade._tokenOut,
          _amount: crvBalance,
          _minAmountOut: BigNumber.from('0'),
        },
        {
          _strategy: this.strategy,
          _tokenIn: this.cvx,
          _tokenOut: trade._tokenOut,
          _amount: cvxBalance,
          _minAmountOut: BigNumber.from('0'),
        },
      ],
      this.multicallSwapper,
      data
    );

    return {
      swapperName: 'CurveSpellEthMulticall',
      transaction: executeTx,
    };
  }

  match(trade: ExtendedEnabledTrade) {
    return (
      trade._strategy == this.strategy &&
      _.includes(trade._tokenIn, this.crv) &&
      _.includes(trade._tokenIn, this.cvx) &&
      trade._tokenOut == this.crvSpellEth
    );
  }
}