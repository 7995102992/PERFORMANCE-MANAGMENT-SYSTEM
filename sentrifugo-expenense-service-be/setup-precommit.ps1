# Installs and activates the pre-commit hooks for this repo (Windows / PowerShell).
# Run once after cloning:  .\setup-precommit.ps1
python -m pip install --upgrade pre-commit
pre-commit install
pre-commit run --all-files
