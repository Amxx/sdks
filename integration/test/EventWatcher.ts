import hre, { ethers } from 'hardhat';
import { expect } from 'chai';
import { splitSignature } from '@ethersproject/bytes';
import { BigNumber, Signer, Event } from 'ethers';

import { BlockchainTime } from './utils/time';

import DutchLimitOrderReactorAbi from '../../abis/DutchLimitOrderReactor.json';
import PermitPostAbi from '../../abis/PermitPost.json';
import MockERC20Abi from '../../abis/MockERC20.json';
import DirectTakerFillContract from '../../abis/DirectTakerExecutor.json';

import {
  PermitPost,
  DutchLimitOrderReactor,
  MockERC20,
} from '../../src/contracts';
import { DutchLimitOrderBuilder, EventWatcher, FillData } from '../../';

describe('EventWatcher', () => {
  let reactor: DutchLimitOrderReactor;
  let fillContract: string;
  let permitPost: PermitPost;
  let chainId: number;
  let maker: ethers.Wallet;
  let tokenIn: MockERC20;
  let tokenOut: MockERC20;
  let admin: Signer;
  let taker: Signer;
  let watcher: EventWatcher;

  before(async () => {
    [admin, taker] = await ethers.getSigners();
    const permitPostFactory = await ethers.getContractFactory(
      PermitPostAbi.abi,
      PermitPostAbi.bytecode
    );
    permitPost = (await permitPostFactory.deploy()) as PermitPost;

    const reactorFactory = await ethers.getContractFactory(
      DutchLimitOrderReactorAbi.abi,
      DutchLimitOrderReactorAbi.bytecode
    );
    reactor = (await reactorFactory.deploy(
      permitPost.address
    )) as DutchLimitOrderReactor;

    chainId = hre.network.config.chainId || 1;

    maker = ethers.Wallet.createRandom().connect(ethers.provider);
    await admin.sendTransaction({
      to: await maker.getAddress(),
      value: BigNumber.from(10).pow(18),
    });

    const directTakerFillContractFactory = await ethers.getContractFactory(
      DirectTakerFillContract.abi,
      DirectTakerFillContract.bytecode
    );
    fillContract = (await directTakerFillContractFactory.deploy(await taker.getAddress())).address;

    const tokenFactory = await ethers.getContractFactory(
      MockERC20Abi.abi,
      MockERC20Abi.bytecode
    );
    tokenIn = (await tokenFactory.deploy('TEST A', 'ta', 18)) as MockERC20;

    tokenOut = (await tokenFactory.deploy('TEST B', 'tb', 18)) as MockERC20;

    await tokenIn.mint(
      await maker.getAddress(),
      BigNumber.from(10)
        .pow(18)
        .mul(100)
    );
    await tokenIn
      .connect(maker)
      .approve(permitPost.address, ethers.constants.MaxUint256);

    await tokenOut.mint(
      await taker.getAddress(),
      BigNumber.from(10)
        .pow(18)
        .mul(100)
    );
    await tokenOut
      .connect(taker)
      .approve(fillContract, ethers.constants.MaxUint256);
    watcher = new EventWatcher(ethers.provider, reactor.address);
  });

  it('Fetches fill events', async () => {
    const amount = BigNumber.from(10).pow(18);
    const deadline = await new BlockchainTime().secondsFromNow(1000);
    const order = new DutchLimitOrderBuilder(
      chainId,
      reactor.address,
      permitPost.address
    )
      .deadline(deadline)
      .endTime(deadline)
      .startTime(deadline - 100)
      .offerer(await maker.getAddress())
      .nonce(BigNumber.from(100))
      .input({
        token: tokenIn.address,
        amount,
      })
      .output({
        token: tokenOut.address,
        startAmount: amount,
        endAmount: BigNumber.from(10)
          .pow(17)
          .mul(9),
        recipient: await maker.getAddress(),
      })
      .build();

    const { domain, types, values } = order.permitData();
    const signature = await maker._signTypedData(domain, types, values);
    const { v, r, s } = splitSignature(signature);

    const res = await reactor.connect(taker).execute(
      { order: order.serialize(), sig: { v, r, s } },
      fillContract,
      "0x"
    );
    await res.wait();

    const logs = await watcher.getFillEvents(0, await ethers.provider.getBlockNumber());
    expect(logs.length).to.equal(1);
    expect(logs[0].orderHash).to.equal(order.hash());
    expect(logs[0].filler).to.equal(await taker.getAddress());
    expect(logs[0].offerer).to.equal(await maker.getAddress());
    expect(logs[0].nonce.toString()).to.equal('100');
  });

  it('Handles callbacks on fill events', async () => {
    const amount = BigNumber.from(10).pow(18);
    const deadline = await new BlockchainTime().secondsFromNow(1000);
    const order = new DutchLimitOrderBuilder(
      chainId,
      reactor.address,
      permitPost.address
    )
      .deadline(deadline)
      .endTime(deadline)
      .startTime(deadline - 100)
      .offerer(await maker.getAddress())
      .nonce(BigNumber.from(101))
      .input({
        token: tokenIn.address,
        amount,
      })
      .output({
        token: tokenOut.address,
        startAmount: amount,
        endAmount: BigNumber.from(10)
          .pow(17)
          .mul(9),
        recipient: await maker.getAddress(),
      })
      .build();

    const { domain, types, values } = order.permitData();
    const signature = await maker._signTypedData(domain, types, values);
    const { v, r, s } = splitSignature(signature);

    const makerAddress = await maker.getAddress();
    const takerAddress = await taker.getAddress();
    watcher.onFill((fill: FillData) => {
      expect(fill.filler).to.equal(takerAddress);
      expect(fill.offerer).to.equal(makerAddress);
    });
    const res = await reactor.connect(taker).execute(
      { order: order.serialize(), sig: { v, r, s } },
      fillContract,
      "0x"
    );
    await res.wait();
  });
});
