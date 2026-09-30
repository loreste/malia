#[path = "../main.rs"]
mod malia_main;

fn main() -> anyhow::Result<()> {
  malia_main::run()
}
