// Fake design source（fixture，仅用于离线测试，不参与真实综合）
`timescale 1ns/1ps
module fake_dut (
    input  wire i_clk,
    input  wire i_rst_n,
    output reg  [7:0] o_data
);
    always @(posedge i_clk) begin
        if (!i_rst_n) o_data <= 8'h00;
        else o_data <= o_data + 8'h01;
    end
endmodule
