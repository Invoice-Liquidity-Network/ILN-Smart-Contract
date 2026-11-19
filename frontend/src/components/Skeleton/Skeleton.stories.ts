import type { Meta, StoryObj } from "@storybook/react";
import { Skeleton } from "./Skeleton";

const meta: Meta<typeof Skeleton> = {
  title: "ILN/Skeleton",
  component: Skeleton,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
  argTypes: {
    width: { control: "text" },
    height: { control: "number" },
    borderRadius: { control: "number" },
  },
};

export default meta;
type Story = StoryObj<typeof Skeleton>;

export const TextLine: Story = {
  args: { width: 200, height: 16 },
};

export const Heading: Story = {
  args: { width: 300, height: 28, borderRadius: 6 },
};

export const Avatar: Story = {
  args: { width: 40, height: 40, borderRadius: 999 },
};

export const Card: Story = {
  args: { width: 320, height: 120, borderRadius: 12 },
};

export const FullWidth: Story = {
  args: { width: "100%", height: 16 },
  decorators: [
    (Story) => {
      const React = require("react");
      return React.createElement("div", { style: { width: 400 } }, React.createElement(Story));
    },
  ],
};
