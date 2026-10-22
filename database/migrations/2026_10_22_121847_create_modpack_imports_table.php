<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('modpack_imports', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('user_id')->nullable();
            $table->unsignedBigInteger('modpack_id')->nullable();
            $table->unsignedBigInteger('build_id')->nullable();
            $table->string('name');
            $table->string('slug')->nullable();
            $table->text('source');
            $table->string('archive_path')->nullable();
            $table->string('build_version')->nullable();
            $table->boolean('overwrite')->default(false);
            $table->string('status', 16);
            $table->unsignedInteger('imported')->default(0);
            $table->unsignedInteger('skipped')->default(0);
            $table->json('problems')->nullable();
            $table->json('log')->nullable();
            $table->timestamps();

            $table->index(['modpack_id', 'created_at']);
            $table->index('created_at');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('modpack_imports');
    }
};
