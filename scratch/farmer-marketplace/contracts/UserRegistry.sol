// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title UserRegistry
 * @notice Manages user registration and admin verification for Farmer, Buyer, and Transporter roles.
 */
contract UserRegistry is AccessControl {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    enum UserRole {
        None,
        Farmer,
        Buyer,
        Transporter
    }

    struct UserProfile {
        UserRole role;
        bool isRegistered;
        bool isVerified;
        uint256 registeredAt;
    }

    mapping(address => UserProfile) public users;

    event UserRegistered(address indexed user, UserRole role);
    event UserVerified(address indexed user, UserRole role);

    error ZeroAddress();
    error InvalidRole();
    error AlreadyRegistered();
    error UserNotRegistered();
    error AlreadyVerified();

    /**
     * @param admin Initial administrator address.
     */
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    /**
     * @notice Allows a user to register as a Farmer, Buyer, or Transporter.
     * @param role The role requested by the caller.
     */
    function register(UserRole role) external {
        if (role == UserRole.None) revert InvalidRole();
        if (users[msg.sender].isRegistered) revert AlreadyRegistered();

        users[msg.sender] = UserProfile({
            role: role,
            isRegistered: true,
            isVerified: false,
            registeredAt: block.timestamp
        });

        emit UserRegistered(msg.sender, role);
    }

    /**
     * @notice Admin verifies a registered user.
     * @param user The address of the user to verify.
     */
    function verifyUser(address user) external onlyRole(ADMIN_ROLE) {
        if (user == address(0)) revert ZeroAddress();
        UserProfile storage profile = users[user];
        if (!profile.isRegistered) revert UserNotRegistered();
        if (profile.isVerified) revert AlreadyVerified();

        profile.isVerified = true;
        emit UserVerified(user, profile.role);
    }

    /**
     * @notice Checks if a user is a verified farmer.
     */
    function isVerifiedFarmer(address user) external view returns (bool) {
        return users[user].isRegistered && users[user].isVerified && users[user].role == UserRole.Farmer;
    }

    /**
     * @notice Checks if a user is a verified buyer.
     */
    function isVerifiedBuyer(address user) external view returns (bool) {
        return users[user].isRegistered && users[user].isVerified && users[user].role == UserRole.Buyer;
    }

    /**
     * @notice Checks if a user is a verified transporter.
     */
    function isVerifiedTransporter(address user) external view returns (bool) {
        return users[user].isRegistered && users[user].isVerified && users[user].role == UserRole.Transporter;
    }

    /**
     * @notice Checks if a user is verified with any role.
     */
    function isVerified(address user) external view returns (bool) {
        return users[user].isRegistered && users[user].isVerified;
    }

    /**
     * @notice Gets the user profile for an address.
     */
    function getUser(address user) external view returns (UserProfile memory) {
        return users[user];
    }
}

