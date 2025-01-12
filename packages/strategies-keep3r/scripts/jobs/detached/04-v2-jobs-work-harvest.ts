import moment from 'moment';
import { HarvestV2DetachedJob, HarvestV2DetachedJob__factory } from '@typechained';
import { ethers } from 'hardhat';
import * as contracts from '../../../utils/contracts';
import { HarvestConfiguration, harvestConfigurations } from '../../../utils/v2-ftm-strategies';

let harvestV2DetachedJob: HarvestV2DetachedJob;
const worked: string[] = [];
const notWorkable: string[] = [];
const onLiquidityCooldown: string[] = [];
const errorWhileWorked: string[] = [];
const lastTimeRewardWasDumped: { [address: string]: number } = {};

const REWARD_DUMPED_COOLDOWN = moment.duration('2.5', 'minutes');

async function main() {
  const [harvester] = await ethers.getSigners();
  const networkName = 'fantom';
  console.log('Using address:', harvester.address, 'on fantom');

  harvestV2DetachedJob = await HarvestV2DetachedJob__factory.connect(contracts.harvestV2DetachedJob[networkName], harvester);

  const sbeetStrats = [
    '0xB905eabA7A23424265638bdACFFE55564c7B299B',
    '0x56aF79e182a7f98ff6d0bF99d589ac2CabA24e2d',
    '0x85c307D24da7086c41537b994de9bFc4C21BAEB5',
    '0xBd3791F3Dcf9DD5633cd30662381C80a2Cd945bd',
    '0xbBdc83357287a29Aae30cCa520D4ed6C750a2a11',
    '0x4003eE222d44953B0C3eB61318dD211a4A6f109f',
    '0x36E74086C388305CEcdeff83d6cf31a2762A3c91',
    '0x1c13C43f8F2fa0CdDEE6DFF6F785757650B8c2BF',
    '0xfD7E0cCc4dE0E3022F47834d7f0122274c37a0d1',
    '0x8Bb79E595E1a21d160Ba3f7f6C94efF1484FB4c9',
  ];

  const strategies = (await harvestV2DetachedJob.callStatic.strategies()).filter((strategy) => sbeetStrats.indexOf(strategy) === -1);

  // Get all last worked at
  const lastWorksAt = await Promise.all(strategies.map((strategy) => getLastWorkAt(strategy)));

  // Map when was the last time a reward token was dumped
  lastWorksAt.forEach((lastWorkAt) => {
    const harvestConfiguration: HarvestConfiguration | undefined = harvestConfigurations.find(
      (harvestConfiguration) => harvestConfiguration.address.toLowerCase() === lastWorkAt.strategy.toLowerCase()
    );
    if (!harvestConfiguration) throw new Error('Mismatch between harvests configuration and job strategies');
    harvestConfiguration.tokensBeingDumped.forEach((tokenBeingDumped) => {
      if (!lastTimeRewardWasDumped.hasOwnProperty(tokenBeingDumped) || lastWorkAt.timestamp > lastTimeRewardWasDumped[tokenBeingDumped]) {
        lastTimeRewardWasDumped[tokenBeingDumped] = lastWorkAt.timestamp;
      }
    });
  });

  for (const strategy of strategies) {
    console.log('Checking strategy', strategy);
    try {
      const strategyHarvestConfiguration: HarvestConfiguration = harvestConfigurations.find(
        (harvestConfiguration) => harvestConfiguration.address.toLowerCase() === strategy.toLowerCase()
      )!;
      const workable = await harvestV2DetachedJob.callStatic.workable(strategy);
      if (!workable) {
        console.log('Not workable');
        console.log('***************************');
        notWorkable.push(strategy);
        continue;
      }

      let isStratOnLiquidityCooldown: boolean = false;
      strategyHarvestConfiguration.tokensBeingDumped.forEach((tokenBeingDumped) => {
        isStratOnLiquidityCooldown =
          isStratOnLiquidityCooldown || moment().subtract(REWARD_DUMPED_COOLDOWN).unix() <= lastTimeRewardWasDumped[tokenBeingDumped];
      });
      if (isStratOnLiquidityCooldown) {
        console.log('On liquidity cooldown');
        console.log('***************************');
        onLiquidityCooldown.push(strategy);
        continue;
      }
      console.log('Working...');
      const gasLimit = await harvestV2DetachedJob.estimateGas.work(strategy);
      const tx = await harvestV2DetachedJob.work(strategy, { gasLimit: gasLimit.mul(110).div(100) });
      strategyHarvestConfiguration.tokensBeingDumped.forEach((tokenBeingDumped) => {
        lastTimeRewardWasDumped[tokenBeingDumped] = moment().unix();
      });
      worked.push(strategy);
      console.log(`Check work tx at https://ftmscan.com/tx/${tx.hash}`);
    } catch (error: any) {
      console.log('Error while working:', error.message);
      errorWhileWorked.push(strategy);
    }
    console.log('***************************');
  }
  console.log('On liqudity cooldown:', onLiquidityCooldown.join(','));
  console.log('***************************');
  console.log('Not workable strategies:', notWorkable.join(','));
  console.log('***************************');
  console.log('Worked strategies:', worked.join(','));
  console.log('***************************');
  console.log('Errored while working:', errorWhileWorked.join(','));
}

const getLastWorkAt = async (strategy: string): Promise<{ strategy: string; timestamp: number }> => {
  return {
    strategy,
    timestamp: (await harvestV2DetachedJob.callStatic.lastWorkAt(strategy)).toNumber(),
  };
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
