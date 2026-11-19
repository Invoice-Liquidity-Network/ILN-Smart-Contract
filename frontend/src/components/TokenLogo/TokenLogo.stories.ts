import type { Meta, StoryObj } from "@storybook/react";
import { TokenLogo } from "./TokenLogo";

const meta: Meta<typeof TokenLogo> = {
  title: "ILN/TokenLogo",
  component: TokenLogo,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
  argTypes: {
    code: {
      control: "select",
      options: ["XLM", "USDC", "BTC", "ETH", "UNKNOWN"],
      description: "Asset code for the token",
    },
    size: {
      control: { type: "number", min: 16, max: 96, step: 8 },
      description: "Icon size in pixels",
    },
  },
};

export default meta;
type Story = StoryObj<typeof TokenLogo>;

export const XLM: Story = {
  args: { code: "XLM", size: 32 },
};

export const USDC: Story = {
  args: { code: "USDC", size: 32 },
};

export const BTC: Story = {
  args: { code: "BTC", size: 32 },
};

export const ETH: Story = {
  args: { code: "ETH", size: 32 },
};

export const Unknown: Story = {
  args: { code: "UNKNOWN", size: 32 },
};

export const Small: Story = {
  args: { code: "XLM", size: 16 },
};

export const Large: Story = {
  args: { code: "XLM", size: 64 },
};
