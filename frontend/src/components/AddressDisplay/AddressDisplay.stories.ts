import type { Meta, StoryObj } from "@storybook/react";
import { AddressDisplay } from "./AddressDisplay";

const EXAMPLE = "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOPQRS";

const meta: Meta<typeof AddressDisplay> = {
  title: "ILN/AddressDisplay",
  component: AddressDisplay,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
  argTypes: {
    address: { control: "text" },
    chars: { control: { type: "number", min: 2, max: 20 } },
    copyable: { control: "boolean" },
  },
};

export default meta;
type Story = StoryObj<typeof AddressDisplay>;

export const Default: Story = {
  args: { address: EXAMPLE },
};

export const WithCopyButton: Story = {
  args: { address: EXAMPLE, copyable: true },
};

export const MoreChars: Story = {
  args: { address: EXAMPLE, chars: 10, copyable: true },
};

export const ShortAddress: Story = {
  args: { address: "GABCD", copyable: true },
};
