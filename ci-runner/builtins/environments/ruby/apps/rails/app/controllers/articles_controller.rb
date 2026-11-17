class ArticlesController < ApplicationController
  def index
    @articles = Article.order(:title)
  end

  def show
    @article = Article.find(params[:id])
  end
end
