// Fake testbench（fixture，仅用于离线测试）
`timescale 1ns/1ps
module fake_tb;
    logic clk = 1'b0;
    logic rst_n = 1'b0;
    logic [7:0] data;

    fake_dut dut (.i_clk(clk), .i_rst_n(rst_n), .o_data(data));

    initial begin
        #10 rst_n = 1'b1;
        $display("[PASS] fake basic");
        $finish;
    end
endmodule
