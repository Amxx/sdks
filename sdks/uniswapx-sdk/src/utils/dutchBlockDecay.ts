import { BigNumber } from "ethers";

import { NonlinearDutchDecay } from "../order";
/*
These functions mimic the smart contract functions as closely as possible to ensure that the same results are produced.
Essentially Solidity translated to TypeScript.
*/
function locateArrayPosition(
	curve: NonlinearDutchDecay,
	currentRelativeBlock: number
): [number, number] {
	const relativeBlocks = curve.relativeBlocks;
	let prev = 0;
	let next = 0; 
	for (; next < relativeBlocks.length; next++) {
		if(relativeBlocks[next] >= currentRelativeBlock) {
			return [prev, next];
		}
		prev = next;
	}
	return [next - 1, next - 1];
}

class NonLinearDutchDecayLib {
	static decay(
		curve: NonlinearDutchDecay,
		startAmount: BigNumber,
		decayStartBlock: number,
		currentBlock: number
	): BigNumber {
		// mismatch of relativeAmounts and relativeBlocks
		if (curve.relativeAmounts.length > 16) {
			throw new Error("InvalidDecayCurve");
		}

		// handle current block before decay or no decay
		if (decayStartBlock >= currentBlock || curve.relativeAmounts.length === 0) {
			return startAmount;
		}

		const blockDelta = currentBlock - decayStartBlock;

		// Special case for when we need to use the decayStartBlock (0)
		if (curve.relativeBlocks[0] > blockDelta) {
			return this.linearDecay(
				0,
				curve.relativeBlocks[0],
				blockDelta,
				startAmount,
				startAmount.sub(curve.relativeAmounts[0].toString())
			);
		}

		// the current pos is within or after the curve
		const [prev, next] = locateArrayPosition(curve, blockDelta);
		//relativeAmounts holds BigInts so we can't directly subtract without conversion
		const lastAmount = startAmount.sub(curve.relativeAmounts[prev].toString());
		const nextAmount = startAmount.sub(curve.relativeAmounts[next].toString());
		return this.linearDecay(
			curve.relativeBlocks[prev],
			curve.relativeBlocks[next],
			blockDelta,
			lastAmount,
			nextAmount
		);
	}

	static linearDecay(
		startPoint: number,
		endPoint: number,
		currentPoint: number,
		startAmount: BigNumber,
		endAmount: BigNumber
	): BigNumber {
		if (currentPoint >= endPoint) {
			return endAmount;
		}

		const elapsed = BigNumber.from(currentPoint - startPoint);
		const duration = BigNumber.from(endPoint - startPoint);
		let delta;
		if (endAmount.lt(startAmount)) {
			delta = BigNumber.from(0).sub((startAmount.sub(endAmount)).mul(elapsed).div(duration)); // mulDivDown in contract
		} else {
			delta = (endAmount.sub(startAmount)).mul(elapsed).div(duration); // mulDivDown in contract
		}
		return startAmount.add(delta);
	}
}

export { NonLinearDutchDecayLib };

export interface DutchBlockDecayConfig {
	decayStartBlock: number;
	startAmount: BigNumber;
	relativeBlocks: number[];
	relativeAmounts: bigint[];
}

export function getBlockDecayedAmount(
	config: DutchBlockDecayConfig,
	atBlock: number
): BigNumber {
	const { decayStartBlock, startAmount, relativeBlocks, relativeAmounts } =
		config;
	return NonLinearDutchDecayLib.decay(
		{ relativeAmounts, relativeBlocks },
		startAmount,
		decayStartBlock,
		atBlock
	);
}

export function getEndAmount(
	config: Partial<DutchBlockDecayConfig>
): BigNumber {
	const { startAmount, relativeAmounts } = config;
	if (!startAmount || !relativeAmounts) {
		throw new Error("Invalid config for getting V3 decay end amount");
	}
	return startAmount.sub(
		relativeAmounts[relativeAmounts.length - 1].toString()
	);
}