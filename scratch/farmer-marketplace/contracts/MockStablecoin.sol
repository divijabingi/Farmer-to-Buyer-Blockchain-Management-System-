// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockStablecoin
 * @notice Mock stablecoin with 6 decimals and a public mint function for test environments.
 */
contract MockStablecoin is ERC20 {
    constructor() ERC20("Mock USD", "mUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /**
     * @notice Public minting function for testing purposes.
     * @param to Recipient address.
     * @param amount Token amount to mint.
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

