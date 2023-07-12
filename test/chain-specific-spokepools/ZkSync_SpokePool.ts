import { mockTreeRoot, amountToReturn, amountHeldByPool } from "../constants";
import {
  ethers,
  expect,
  Contract,
  FakeContract,
  SignerWithAddress,
  toWei,
  getContractFactory,
  seedContract,
  avmL1ToL2Alias,
} from "../../utils/utils";
import { hre } from "../../utils/utils.hre";

import { hubPoolFixture } from "../fixtures/HubPool.Fixture";
import { constructSingleRelayerRefundTree } from "../MerkleLib.utils";
import { smock } from "@defi-wonderland/smock";

let hubPool: Contract, zkSyncSpokePool: Contract, dai: Contract, weth: Contract;
let l2Dai: string, crossDomainAliasAddress, crossDomainAlias: SignerWithAddress;
let owner: SignerWithAddress, relayer: SignerWithAddress, rando: SignerWithAddress;
let zkErc20Bridge: FakeContract, l2Eth: FakeContract;

// TODO: Grab the following from relayer-v2/CONTRACT_ADDRESSES dictionary?
const abiData = {
  erc20DefaultBridge: {
    address: "0x11f943b2c77b743ab90f4a0ae7d5a4e7fca3e102",
    abi: [
      {
        inputs: [
          { internalType: "address", name: "_l1Receiver", type: "address" },
          { internalType: "address", name: "_l2Token", type: "address" },
          { internalType: "uint256", name: "_amount", type: "uint256" },
        ],
        name: "withdraw",
        outputs: [],
        payable: false,
        stateMutability: "nonpayable",
        type: "function",
      },
    ],
  },
  eth: {
    address: "0x000000000000000000000000000000000000800A",
    abi: [
      {
        inputs: [{ internalType: "address", name: "_l1Receiver", type: "address" }],
        name: "withdraw",
        outputs: [],
        payable: true,
        stateMutability: "payable",
        type: "function",
      },
    ],
  },
};

describe("ZkSync Spoke Pool", function () {
  beforeEach(async function () {
    [owner, relayer, rando] = await ethers.getSigners();
    ({ weth, dai, l2Dai, hubPool } = await hubPoolFixture());

    // Create an alias for the Owner. Impersonate the account. Crate a signer for it and send it ETH.
    crossDomainAliasAddress = avmL1ToL2Alias(owner.address); // @dev Uses same aliasing algorithm as Arbitrum
    await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [crossDomainAliasAddress] });
    crossDomainAlias = await ethers.getSigner(crossDomainAliasAddress);
    await owner.sendTransaction({ to: crossDomainAliasAddress, value: toWei("1") });

    zkErc20Bridge = await smock.fake(abiData.erc20DefaultBridge.abi, { address: abiData.erc20DefaultBridge.address });
    l2Eth = await smock.fake(abiData.eth.abi, { address: abiData.eth.address });

    zkSyncSpokePool = await hre.upgrades.deployProxy(
      await getContractFactory("ZkSync_SpokePool", owner),
      [0, zkErc20Bridge.address, owner.address, hubPool.address, weth.address],
      { kind: "uups" }
    );

    await seedContract(zkSyncSpokePool, relayer, [dai], weth, amountHeldByPool);
  });

  it("Only cross domain owner upgrade logic contract", async function () {
    // TODO: Could also use upgrades.prepareUpgrade but I'm unclear of differences
    const implementation = await hre.upgrades.deployImplementation(
      await getContractFactory("ZkSync_SpokePool", owner),
      { kind: "uups" }
    );

    // upgradeTo fails unless called by cross domain admin
    await expect(zkSyncSpokePool.upgradeTo(implementation)).to.be.revertedWith("ONLY_COUNTERPART_GATEWAY");
    await zkSyncSpokePool.connect(crossDomainAlias).upgradeTo(implementation);
  });
  it("Only cross domain owner can set ZKBridge", async function () {
    await expect(zkSyncSpokePool.setZkBridge(rando.address)).to.be.reverted;
    await zkSyncSpokePool.connect(crossDomainAlias).setZkBridge(rando.address);
    expect(await zkSyncSpokePool.zkErc20Bridge()).to.equal(rando.address);
  });
  it("Only cross domain owner can relay admin root bundles", async function () {
    const { tree } = await constructSingleRelayerRefundTree(l2Dai, await zkSyncSpokePool.callStatic.chainId());
    await expect(zkSyncSpokePool.relayRootBundle(tree.getHexRoot(), mockTreeRoot)).to.be.revertedWith(
      "ONLY_COUNTERPART_GATEWAY"
    );
  });
  it("Bridge tokens to hub pool correctly calls the Standard L2 Bridge for ERC20", async function () {
    const { leaves, tree } = await constructSingleRelayerRefundTree(l2Dai, await zkSyncSpokePool.callStatic.chainId());
    await zkSyncSpokePool.connect(crossDomainAlias).relayRootBundle(tree.getHexRoot(), mockTreeRoot);
    await zkSyncSpokePool.connect(relayer).executeRelayerRefundLeaf(0, leaves[0], tree.getHexProof(leaves[0]));

    // This should have sent tokens back to L1. Check the correct methods on the gateway are correctly called.
    expect(zkErc20Bridge.withdraw).to.have.been.calledOnce;
    expect(zkErc20Bridge.withdraw).to.have.been.calledWith(hubPool.address, l2Dai, amountToReturn);
  });
  it("Bridge ETH to hub pool correctly calls the Standard L2 Bridge for WETH, including unwrap", async function () {
    const { leaves, tree } = await constructSingleRelayerRefundTree(
      weth.address,
      await zkSyncSpokePool.callStatic.chainId()
    );
    await zkSyncSpokePool.connect(crossDomainAlias).relayRootBundle(tree.getHexRoot(), mockTreeRoot);

    // Executing the refund leaf should cause spoke pool to unwrap WETH to ETH to prepare to send it as msg.value
    // to the ERC20 bridge. This results in a net decrease in WETH balance.
    await expect(() =>
      zkSyncSpokePool.connect(relayer).executeRelayerRefundLeaf(0, leaves[0], tree.getHexProof(leaves[0]))
    ).to.changeTokenBalance(weth, zkSyncSpokePool, amountToReturn.mul(-1));
    expect(l2Eth.withdraw).to.have.been.calledWithValue(amountToReturn);
    expect(l2Eth.withdraw).to.have.been.calledWith(hubPool.address);
  });
});
