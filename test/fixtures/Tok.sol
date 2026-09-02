// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract Tok {
    string public name = "Test Token";
    string public symbol = "TT";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor() {
        balanceOf[msg.sender] = 1000e18;
        emit Transfer(address(0), msg.sender, 1000e18);
    }

    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        emit Transfer(msg.sender, to, v);
        return true;
    }
}
