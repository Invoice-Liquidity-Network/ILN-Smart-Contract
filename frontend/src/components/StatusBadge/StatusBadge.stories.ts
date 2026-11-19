import type { Meta, StoryObj } from "@storybook/react";
import { StatusBadge } from "./StatusBadge";
import type { InvoiceStatus } from "./StatusBadge";

const meta: Meta<typeof StatusBadge> = {
  title: "ILN/StatusBadge",
  component: StatusBadge,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
  argTypes: {
    status: {
      control: "select",
      options: ["PENDING", "FUNDED", "PAID", "CANCELLED", "EXPIRED", "DISPUTED"] satisfies InvoiceStatus[],
    },
  },
};

export default meta;
type Story = StoryObj<typeof StatusBadge>;

export const Pending: Story = {
  args: { status: "PENDING" },
};

export const Funded: Story = {
  args: { status: "FUNDED" },
};

export const Paid: Story = {
  args: { status: "PAID" },
};

export const Cancelled: Story = {
  args: { status: "CANCELLED" },
};

export const Expired: Story = {
  args: { status: "EXPIRED" },
};

export const Disputed: Story = {
  args: { status: "DISPUTED" },
};
