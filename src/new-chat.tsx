// Entry point for the "New Chat with Pi" command.
// The shared PiChat component detects environment.commandName === "new-chat"
// and starts pi with --no-session, clearing stored messages.
export { default } from "./pi-chat";
