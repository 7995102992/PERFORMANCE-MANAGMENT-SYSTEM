package com.sentrifugo.db.mapper;

import com.sentrifugo.db.dto.PmsCycleEmploymentTypeDTO;
import com.sentrifugo.db.entity.PmsCycleEmploymentTypeEntity;
import org.mapstruct.Builder;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.MappingTarget;
import org.mapstruct.NullValuePropertyMappingStrategy;
import org.mapstruct.ReportingPolicy;

import java.util.List;

@Mapper(
        componentModel = "spring",
        unmappedTargetPolicy = ReportingPolicy.IGNORE,
        nullValuePropertyMappingStrategy = NullValuePropertyMappingStrategy.IGNORE,
        // Lombok @SuperBuilder entities/DTOs: map through constructor + setters (see PmsCycleMapper).
        builder = @Builder(disableBuilder = true)
)
public interface PmsCycleEmploymentTypeMapper {

    // Parent / referenced entities are resolved and attached by the service, never taken from the DTO.
    @Mapping(target = "cycle", ignore = true)
    PmsCycleEmploymentTypeEntity toEntity(PmsCycleEmploymentTypeDTO dto);

    @Mapping(source = "cycle.id", target = "cycleId")
    PmsCycleEmploymentTypeDTO toDTO(PmsCycleEmploymentTypeEntity entity);

    List<PmsCycleEmploymentTypeEntity> toEntityList(List<PmsCycleEmploymentTypeDTO> dtoList);

    List<PmsCycleEmploymentTypeDTO> toDTOList(List<PmsCycleEmploymentTypeEntity> entityList);

    @Mapping(target = "id", ignore = true)
    @Mapping(target = "cycle", ignore = true)
    void updateEntityFromDto(PmsCycleEmploymentTypeDTO dto, @MappingTarget PmsCycleEmploymentTypeEntity entity);
}
